"""Reject Whisper hallucinations instead of storing them as unverified speech."""

import os

# Whisper was trained on subtitle tracks, so on near-silent audio it reproduces
# the credit lines those tracks end with. Every Large-v3 second opinion taken on
# the owner's server during the first week was one of these, in Japanese,
# Russian, or as a two-word filler. Matching is a lowercase substring test, so
# each entry stays short and is kept in the language it appears in.
HALLUCINATION_PHRASES = (
    "thank you for watching",
    "thanks for watching",
    "please subscribe",
    "subscribe to my channel",
    "subscribe to the channel",
    "subtitles by",
    "subtitles created by",
    "subs by",
    "dimatorzok",
    "amara.org",
    "transcription by",
    "sous-titres",
    "sottotitoli",
    "untertitel",
    "subtitulado por",
    "subtítulos realizados por",
    "字幕",
    "ご視聴ありがとうございました",
    "ご清聴ありがとうございました",
    "チャンネル登録",
    "субтитры",
    "спасибо за просмотр",
    "продолжение следует",
    "редактор субтитров",
)

# faster-whisper's own decoding statistics, at the thresholds Whisper itself
# uses to discard a decoding attempt.
MAX_NO_SPEECH_PROBABILITY = 0.6
MIN_AVERAGE_LOGPROB = -1.0
MAX_COMPRESSION_RATIO = 2.4
# Below this, the Medium pass's detected language is a guess about noise rather
# than evidence of what was spoken.
MIN_LANGUAGE_PROBABILITY = 0.5
# Rejected text is kept only so the owner can see what was filtered, so bound it
# against the published per-review result size limit.
MAX_REJECTED_SEGMENTS = 10
MAX_REJECTED_TEXT = 200


def configured_language() -> str:
    """Return the language the cameras are expected to hear."""
    return os.environ.get("AUDIO_TRIAL_LANGUAGE", "en").strip() or "en"


def matched_phrase(text: str) -> str | None:
    """Return the known subtitle credit this text repeats, if it repeats one."""
    lowered = text.casefold()
    for phrase in HALLUCINATION_PHRASES:
        if phrase in lowered:
            return phrase
    return None


def segment_rejection(segment) -> str | None:
    """Name why one decoded segment is untrustworthy, or return None to keep it."""
    text = getattr(segment, "text", "").strip()
    phrase = matched_phrase(text)
    if phrase:
        return f"known hallucination phrase: {phrase}"
    if getattr(segment, "no_speech_prob", 0.0) > MAX_NO_SPEECH_PROBABILITY:
        return "no speech probability above threshold"
    if getattr(segment, "avg_logprob", 0.0) < MIN_AVERAGE_LOGPROB:
        return "average log probability below threshold"
    if getattr(segment, "compression_ratio", 0.0) > MAX_COMPRESSION_RATIO:
        return "compression ratio above threshold"
    return None


def filter_segments(segments) -> tuple[list[str], list[dict]]:
    """Split decoded segments into kept text and a record of what was dropped."""
    kept = []
    rejected = []
    for segment in segments:
        text = getattr(segment, "text", "").strip()
        reason = segment_rejection(segment)
        if reason:
            if len(rejected) < MAX_REJECTED_SEGMENTS:
                rejected.append({"text": text[:MAX_REJECTED_TEXT], "reason": reason})
        elif text:
            kept.append(text)
    return kept, rejected


def second_opinion_rejection(medium: dict, large: dict) -> str | None:
    """Name why a Large second opinion must not be stored, or return None."""
    expected = configured_language()
    probability = medium.get("language_probability") or 0.0
    if medium.get("transcript", "").strip() and probability >= MIN_LANGUAGE_PROBABILITY:
        expected = medium.get("language") or expected
    language = large.get("language")
    if language and language != expected:
        return f"language {language} differs from {expected}"
    transcript = large.get("transcript", "").strip()
    if not transcript:
        dropped = large.get("rejected_segments") or []
        if dropped:
            return dropped[0]["reason"]
        return "no transcript"
    phrase = matched_phrase(transcript)
    if phrase:
        return f"known hallucination phrase: {phrase}"
    return None
