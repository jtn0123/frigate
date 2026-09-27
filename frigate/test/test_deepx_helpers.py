"""Tests for the DEEPX .dxnn graph readers and the PPU head load message."""

import unittest
from unittest.mock import patch

from frigate.detectors.plugins import deepx
from frigate.detectors.plugins.deepx import (
    DXNN_GRAPH_SECTION,
    DeepxDetector,
    PpuLayout,
    _dxnn_graph_nodes,
    _onnx_node,
)
from frigate.test.test_deepx import proto_bytes, proto_number


def node_blob(inputs: list[str], outputs: list[str], name: str, op: str) -> bytes:
    blob = b"".join(proto_bytes(1, value.encode()) for value in inputs)
    blob += b"".join(proto_bytes(2, value.encode()) for value in outputs)
    return blob + proto_bytes(3, name.encode()) + proto_bytes(4, op.encode())


class TestOnnxNode(unittest.TestCase):
    def test_fields_are_decoded_and_unknown_fields_skipped(self):
        blob = node_blob(["a", "b"], ["c"], "concat", "Concat")
        blob += proto_bytes(9, b"ignored") + proto_number(10, 3)

        self.assertEqual(
            _onnx_node(blob),
            {
                "input": ["a", "b"],
                "output": ["c"],
                "name": "concat",
                "op_type": "Concat",
            },
        )

    def test_an_empty_node_keeps_the_defaults(self):
        self.assertEqual(
            _onnx_node(b""), {"input": [], "output": [], "name": "", "op_type": ""}
        )


class TestDxnnGraphNodes(unittest.TestCase):
    def test_nodes_of_every_graph_section_are_joined(self):
        graphs = {
            "first": proto_bytes(7, proto_bytes(1, node_blob([], ["x"], "a", "Mul"))),
            "second": proto_bytes(7, proto_bytes(1, node_blob(["x"], [], "b", "Add"))),
        }
        data = {DXNN_GRAPH_SECTION: {name: name for name in graphs}}

        nodes = _dxnn_graph_nodes(data, lambda entry: graphs[entry])

        self.assertEqual([node["name"] for node in nodes], ["a", "b"])

    def test_no_graph_section_gives_no_nodes(self):
        self.assertEqual(_dxnn_graph_nodes({}, lambda entry: b""), [])
        self.assertEqual(_dxnn_graph_nodes({DXNN_GRAPH_SECTION: None}, bytes), [])

    def test_an_unreadable_section_gives_no_nodes(self):
        def section(entry: dict) -> bytes:
            raise OSError("short read")

        data = {DXNN_GRAPH_SECTION: {"graph": {"offset": 0, "size": 4}}}
        self.assertEqual(_dxnn_graph_nodes(data, section), [])


class TestInspectPpuHeadMessage(unittest.TestCase):
    def inspect(self, layout: PpuLayout) -> str:
        detector = DeepxDetector.__new__(DeepxDetector)

        with (
            patch.object(deepx, "read_ppu_layout", return_value=layout),
            self.assertLogs(deepx.logger, "INFO") as logs,
        ):
            self.assertIs(detector.inspect_ppu_head("model.dxnn"), layout)

        return logs.output[0]

    def test_the_box_format_is_named_only_when_the_model_states_it(self):
        cases = {
            None: ("anchor-based", True, ((80, 80), (40, 40))),
            True: ("boxes as a centre and size", False, ((80, 80),)),
            False: ("boxes as two corners", False, ((80, 80),)),
        }

        for centre, (expected, anchor_based, grids) in cases.items():
            with self.subTest(centre_boxes=centre):
                message = self.inspect(PpuLayout(anchor_based, grids, centre))
                self.assertIn(expected, message)
                if centre is None:
                    self.assertNotIn("boxes as", message)


if __name__ == "__main__":
    unittest.main()
