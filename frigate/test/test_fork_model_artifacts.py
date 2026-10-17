"""Pinned model constructors and artifact integrity regressions."""

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from frigate.embeddings.onnx.jina_v1_embedding import (
    JinaV1ImageEmbedding,
    JinaV1TextEmbedding,
)
from frigate.embeddings.onnx.jina_v2_embedding import JinaV2Embedding
from frigate.fork import model_artifacts as artifacts


class TestPinnedJinaConstructors(unittest.TestCase):
    def test_image_loader_verifies_both_files_before_loading_local_processor(self):
        model = object.__new__(JinaV1ImageEmbedding)
        model.runner = None
        model.downloader = None
        model.model_name = "jinaai/jina-clip-v1"
        model.model_file = "vision_model_quantized.onnx"
        model.download_path = "/verified/cache"
        model.download_urls = {
            model.model_file: "unused",
            "preprocessor_config.json": "unused",
        }
        model.device = "CPU"
        module = JinaV1ImageEmbedding.__module__
        with (
            patch(f"{module}.verify_artifact") as verify,
            patch(f"{module}.CLIPImageProcessor.from_pretrained") as load,
            patch(f"{module}.get_optimized_runner") as runner,
        ):
            model._load_model_and_utils()
        self.assertEqual(
            [call.args[1] for call in verify.call_args_list],
            [model.model_file, "preprocessor_config.json"],
        )
        load.assert_called_once_with(
            "/verified/cache", local_files_only=True, trust_remote_code=False
        )
        runner.assert_called_once()
        self.assertIs(model.runner, runner.return_value)

    def test_every_jina_download_uses_an_immutable_revision(self):
        for embedding in (JinaV1TextEmbedding, JinaV1ImageEmbedding, JinaV2Embedding):
            for size in ("small", "large"):
                with (
                    self.subTest(embedding=embedding.__name__, size=size),
                    patch(f"{embedding.__module__}.ModelDownloader"),
                    patch.object(embedding, "_load_model_and_utils"),
                    patch("os.path.exists", return_value=False),
                ):
                    model = embedding(size, Mock())
                    for url in model.download_urls.values():
                        self.assertRegex(url, r"/resolve/[0-9a-f]{40}/")
                    self.assertRegex(model.download_path, r"/[0-9a-f]{40}$")

    def test_loaders_only_use_verified_local_tokenizers_without_remote_code(self):
        for embedding in (JinaV1TextEmbedding, JinaV2Embedding):
            with self.subTest(embedding=embedding.__name__):
                model = object.__new__(embedding)
                model.runner = None
                model.downloader = None
                model.model_name = (
                    "jinaai/jina-clip-v1"
                    if embedding is JinaV1TextEmbedding
                    else "jinaai/jina-clip-v2"
                )
                model.model_file = "model.onnx"
                model.download_path = "/verified/cache"
                model.download_urls = {"model.onnx": "unused"}
                model.device = "CPU"
                with (
                    patch(f"{embedding.__module__}.verify_artifact"),
                    patch(
                        f"{embedding.__module__}.verified_tokenizer_path",
                        return_value="/verified/cache/tokenizer",
                    ),
                    patch(
                        f"{embedding.__module__}.AutoTokenizer.from_pretrained"
                    ) as load,
                    patch(f"{embedding.__module__}.get_optimized_runner"),
                ):
                    model._load_model_and_utils()
                load.assert_called_once_with(
                    "/verified/cache/tokenizer",
                    local_files_only=True,
                    trust_remote_code=False,
                    clean_up_tokenization_spaces=True,
                )

    def test_changed_cached_model_is_rejected_before_any_loader_runs(self):
        model = object.__new__(JinaV1TextEmbedding)
        model.runner = None
        model.downloader = None
        model.model_name = "jinaai/jina-clip-v1"
        model.model_file = "model.onnx"
        model.download_path = "/changed/cache"
        with (
            patch(
                f"{JinaV1TextEmbedding.__module__}.verify_artifact",
                side_effect=ValueError("changed"),
            ),
            patch(
                f"{JinaV1TextEmbedding.__module__}.AutoTokenizer.from_pretrained"
            ) as load,
            patch(f"{JinaV1TextEmbedding.__module__}.get_optimized_runner") as runner,
            self.assertRaises(ValueError),
        ):
            model._load_model_and_utils()
        load.assert_not_called()
        runner.assert_not_called()


class TestArtifactIntegrity(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.payload = b"reviewed artifact"
        self.pin = {
            "jina/test": {
                "revision": "a" * 40,
                "files": {
                    "tokenizer.json": {
                        "path": "tokenizer.json",
                        "sha256": hashlib.sha256(self.payload).hexdigest(),
                    }
                },
            },
        }
        patcher = patch.object(artifacts, "PINS", self.pin)
        patcher.start()
        self.addCleanup(patcher.stop)

    def response(self, data):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.iter_content.return_value = [data[:5], data[5:]]
        return response

    def test_verified_download_is_published_and_uses_the_pinned_url(self):
        path = self.directory / "tokenizer.json"
        with patch.object(
            artifacts.requests, "get", return_value=self.response(self.payload)
        ) as get:
            artifacts.download_artifact("jina/test", path.name, path)
        self.assertEqual(path.read_bytes(), self.payload)
        self.assertIn("/resolve/" + "a" * 40 + "/", get.call_args.args[0])
        self.assertEqual(list(self.directory.iterdir()), [path])
        artifacts.verify_artifact("jina/test", path.name, path)

    def test_changed_download_never_replaces_an_existing_artifact(self):
        path = self.directory / "tokenizer.json"
        path.write_bytes(self.payload)
        with (
            patch.object(
                artifacts.requests,
                "get",
                return_value=self.response(b"changed content"),
            ),
            self.assertRaisesRegex(ValueError, "integrity"),
        ):
            artifacts.download_artifact("jina/test", path.name, path)
        self.assertEqual(path.read_bytes(), self.payload)
        self.assertEqual(list(self.directory.iterdir()), [path])

    def test_cached_file_tampering_is_detected(self):
        path = self.directory / "tokenizer.json"
        path.write_bytes(b"changed content")
        with self.assertRaisesRegex(ValueError, "integrity"):
            artifacts.verify_artifact("jina/test", path.name, path)

    def test_tokenizer_directory_is_never_published_incomplete(self):
        path = self.directory / "tokenizer"
        with (
            patch.object(
                artifacts.requests,
                "get",
                return_value=self.response(b"changed content"),
            ),
            self.assertRaises(ValueError),
        ):
            artifacts.download_tokenizer("jina/test", str(path))
        self.assertFalse(path.exists())
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_complete_tokenizer_is_published_and_cached_tampering_is_rejected(self):
        path = self.directory / "tokenizer"
        with patch.object(
            artifacts.requests, "get", return_value=self.response(self.payload)
        ):
            artifacts.download_tokenizer("jina/test", str(path))
        self.assertEqual(
            artifacts.verified_tokenizer_path("jina/test", str(self.directory)),
            str(path),
        )
        (path / "tokenizer.json").write_bytes(b"changed cache")
        with self.assertRaisesRegex(ValueError, "integrity"):
            artifacts.verified_tokenizer_path("jina/test", str(self.directory))

    def test_insecure_or_credentialed_mirror_is_rejected(self):
        for endpoint in (
            "http://mirror.invalid",
            "https://user@mirror.invalid",
            "https://@mirror.invalid",
            "https://:placeholder@mirror.invalid",
        ):
            with (
                self.subTest(endpoint=endpoint),
                patch.dict("os.environ", {"HF_ENDPOINT": endpoint}),
                self.assertRaises(ValueError),
            ):
                artifacts.artifact_urls("jina/test", ["tokenizer.json"])
