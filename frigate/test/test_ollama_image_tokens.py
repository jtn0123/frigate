import io
import unittest
from unittest.mock import MagicMock

from PIL import Image

from frigate.config import GenAIConfig, GenAIProviderEnum
from frigate.genai import PROVIDERS, load_providers

load_providers()

BASELINE_TOKENS = 12
IMAGE_TOKENS = 1055


def _client(**provider_options):
    """Build an Ollama client offline with a fake server that reports token counts."""
    cfg = GenAIConfig(
        provider="ollama",
        model="qwen3-vl:8b-instruct",
        base_url="http://localhost:9999",
        provider_options=provider_options,
    )
    client = PROVIDERS[GenAIProviderEnum.ollama](cfg, timeout=5, validate_model=False)
    client.provider = MagicMock()
    client.provider.show.return_value = {"capabilities": ["completion", "vision"]}
    client.provider.generate.side_effect = lambda model, prompt, images=None, **kwargs: {
        "prompt_eval_count": BASELINE_TOKENS + (IMAGE_TOKENS if images else 0)
    }
    return client


class TestOllamaImageTokenEstimate(unittest.TestCase):
    def test_measures_image_cost_against_a_text_baseline(self):
        client = _client()

        self.assertEqual(client.estimate_image_tokens(320, 180), IMAGE_TOKENS)

    def test_caches_per_size_and_measures_the_baseline_once(self):
        client = _client()

        client.estimate_image_tokens(320, 180)
        client.estimate_image_tokens(320, 180)
        client.estimate_image_tokens(853, 480)

        images = [c.kwargs["images"] for c in client.provider.generate.call_args_list]
        self.assertEqual(len(images), 3)
        self.assertIsNone(images[0])

    def test_probe_keeps_the_configured_context_and_keep_alive(self):
        client = _client(keep_alive=-1, options={"num_ctx": 32768})

        client.estimate_image_tokens(320, 180)

        for call in client.provider.generate.call_args_list:
            self.assertEqual(call.args[0], "qwen3-vl:8b-instruct")
            self.assertEqual(call.kwargs["keep_alive"], -1)
            self.assertEqual(call.kwargs["options"]["num_ctx"], 32768)
            self.assertEqual(call.kwargs["options"]["num_predict"], 1)
        image = client.provider.generate.call_args_list[1].kwargs["images"][0]
        self.assertEqual(Image.open(io.BytesIO(image)).size, (320, 180))
        self.assertNotIn("num_predict", client.provider_options["options"])

    def test_probe_disables_thinking_when_the_model_supports_it(self):
        client = _client()
        client.provider.show.return_value = {"capabilities": ["vision", "thinking"]}

        client.estimate_image_tokens(320, 180)

        self.assertIs(client.provider.generate.call_args.kwargs["think"], False)

    def test_falls_back_to_the_pixel_heuristic_when_ollama_fails(self):
        client = _client()
        client.provider.generate.side_effect = ConnectionError("down")

        self.assertAlmostEqual(client.estimate_image_tokens(320, 180), 320 * 180 / 1250)
        self.assertEqual(client._image_token_cache, {})

    def test_uses_the_pixel_heuristic_without_a_provider(self):
        client = _client()
        provider = client.provider
        client.provider = None

        self.assertAlmostEqual(client.estimate_image_tokens(640, 360), 640 * 360 / 1250)
        provider.generate.assert_not_called()

    def test_reinitializing_the_provider_clears_measurements(self):
        client = _client()
        client.estimate_image_tokens(320, 180)

        client._init_provider()

        self.assertEqual(client._image_token_cache, {})
        self.assertIsNone(client._text_baseline_tokens)


if __name__ == "__main__":
    unittest.main()
