"""Pure aggregate research reporting. Agreement is never treated as accuracy.

No files, photos, network, model imports, identities or per-photo rows are emitted.
The orchestration layer must validate current consent and retention before calling.
"""

from collections import Counter, defaultdict
from itertools import combinations
import math
import re
import statistics

from .vision_api import FEATURES, FEATURE_VALUES, PINNED_MODEL, validate_observations


PRICE_DATE = "2026-10-11"
INPUT_USD_PER_MILLION = 0.40
OUTPUT_USD_PER_MILLION = 1.60
# Saved eight-head protocol, not a semantic or ordinal mapping to visible features.
_LOCAL_CODES = {"sensitivity": ("NS", "S"), "pigmentation": ("P0", "P1", "P2"),
                "wrinkles": ("W0", "W1", "W2"), "acne": ("NA", "A"), "pores": ("NVP", "VP"),
                "sagging": ("NSA", "SA"), "keratin": ("ND", "D"), "redness": ("NR", "R")}
_LOCAL_KEYS = tuple(_LOCAL_CODES)
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("Invalid comparison measurement.")
    return value


def _identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("Invalid comparison identifier.")
    return value


def _distribution(values):
    if not values:
        return {"measured": 0, "median_ms": None, "p95_ms": None}
    ordered = sorted(values)
    return {"measured": len(values), "median_ms": statistics.median(ordered),
            "p95_ms": ordered[math.ceil(0.95 * len(ordered)) - 1]}


def _repeat_agreement(grouped):
    # Equal participant weight: someone with many captures cannot dominate.
    agreements, pairs = [], 0
    for captures in grouped.values():
        comparisons = list(combinations(captures, 2))
        if comparisons:
            agreements.append(sum(a == b for a, b in comparisons) / len(comparisons))
            pairs += len(comparisons)
    return {"participant_groups_compared": len(agreements), "capture_pairs": pairs,
            "mean_participant_exact_agreement": statistics.mean(agreements) if agreements else None}


def build_report(config: dict, rows: list[dict]) -> dict:
    """Aggregate safe completed rows; missing rows remain explicit failures/unknowns."""
    expected = config.get("photo_count")
    if isinstance(expected, bool) or not isinstance(expected, int) or not 0 <= expected <= 100 or len(rows) > expected:
        raise ValueError("Invalid comparison photo count.")
    evaluation_id, run_id = _identifier(config.get("evaluation_id")), _identifier(config.get("run_id"))
    statuses = {"local": Counter(), "openai": Counter()}
    times = {"local": [], "openai": []}
    repeat = {"local": defaultdict(list), "openai": defaultdict(list)}
    feature_counts = {feature: Counter() for feature in FEATURES}
    quality_counts = Counter()
    participants, photos = set(), set()
    billed_input = billed_output = known_usage = 0
    for row in rows:
        photo, group = _identifier(row.get("photo_id")), _identifier(row.get("participant_group"))
        if photo in photos:
            raise ValueError("Duplicate comparison result.")
        photos.add(photo)
        participants.add(group)
        for provider in ("local", "openai"):
            value = row.get(provider)
            allowed = {"completed", "unavailable"} if provider == "local" else {"completed", "refused", "unavailable"}
            if not isinstance(value, dict) or value.get("status") not in allowed:
                raise ValueError("Invalid comparison provider result.")
            statuses[provider][value["status"]] += 1
            times[provider].append(_number(value.get("latency_ms")))
        local, remote = row["local"], row["openai"]
        if local["status"] == "completed":
            heads = local.get("heads")
            if not isinstance(heads, list) or len(heads) != len(_LOCAL_KEYS):
                raise ValueError("Invalid local code vector.")
            vector = {head.get("key"): head.get("predicted_code") for head in heads if isinstance(head, dict)}
            if set(vector) != set(_LOCAL_KEYS) or any(code not in _LOCAL_CODES[key] for key, code in vector.items()):
                raise ValueError("Invalid local code vector.")
            repeat["local"][group].append(tuple(vector[key] for key in _LOCAL_KEYS))
        if remote.get("model") != PINNED_MODEL:
            raise ValueError("Unrecognized comparison model.")
        usage = remote.get("usage")
        if usage is not None:
            if not isinstance(usage, dict) or set(usage) != {"input_tokens", "output_tokens", "total_tokens"}:
                raise ValueError("Invalid comparison token usage.")
            if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in usage.values()) or usage["total_tokens"] != usage["input_tokens"] + usage["output_tokens"]:
                raise ValueError("Invalid comparison token usage.")
            known_usage += 1
            billed_input += usage["input_tokens"]
            billed_output += usage["output_tokens"]
        if remote["status"] == "completed":
            observation = validate_observations(remote.get("observations"))
            features = observation["observed_features"]
            quality_counts[observation["image_quality"]] += 1
            for feature, value in features.items():
                feature_counts[feature][value] += 1
            if all(value in {"visible", "not_visible"} for value in features.values()):
                repeat["openai"][group].append(tuple(features[key] for key in FEATURES))

    providers = {}
    for provider in ("local", "openai"):
        providers[provider] = {"completed": statuses[provider]["completed"],
                               "unavailable": statuses[provider]["unavailable"],
                               "missing_or_interrupted": expected - len(rows),
                               "completion_rate_all_photos": statuses[provider]["completed"] / expected if expected else None,
                               "latency": _distribution(times[provider]),
                               "within_participant_capture_agreement": _repeat_agreement(repeat[provider])}
    providers["openai"].update({"refused": statuses["openai"]["refused"], "image_quality_counts": dict(quality_counts),
                                 "feature_value_counts": {key: {value: counts[value] for value in FEATURE_VALUES} for key, counts in feature_counts.items()},
                                 "token_usage": {"responses_with_usage": known_usage, "responses_without_usage": len(rows) - known_usage,
                                                 "missing_or_interrupted_usage": expected - len(rows),
                                                 "input_tokens": billed_input, "output_tokens": billed_output},
                                 "estimated_uncached_usd_for_known_usage": round((billed_input * INPUT_USD_PER_MILLION + billed_output * OUTPUT_USD_PER_MILLION) / 1_000_000, 8) if known_usage else None})
    return {"schema_version": 1, "evaluation_id": evaluation_id, "run_id": run_id,
            "eligible_photo_count": expected, "recorded_photo_count": len(rows), "recorded_participant_groups": len(participants),
            "providers": providers,
            "pricing": {"checked_on": PRICE_DATE, "input_usd_per_million": INPUT_USD_PER_MILLION,
                        "output_usd_per_million": OUTPUT_USD_PER_MILLION,
                        "basis": "Actual API usage, standard uncached rates; estimate only, not invoice. No image multiplier reapplied."},
            "decision": {"winner": None, "accuracy_comparison_available": False, "production_switch_authorized": False,
                         "reason": "Source-code meanings/common labels and independent human reference are unverified."},
            "limitations": [
                "Completion is a protocol result, not correct skin assessment. Quality flags are model outputs, not reference labels.",
                "Capture agreement measures within-model stability, not accuracy. Different lighting/captures can legitimately change appearance.",
                "OpenAI capture agreement excludes uncertain/not_assessable vectors; see full feature counts and failures separately.",
                "Local agreement compares eight-code vectors; OpenAI agreement compares five-feature vectors on a different eligible cohort. Their rates are not directly comparable.",
                "All captures from one participant form one group. Small pilot counts do not establish generalization or clinical validity.",
                "Both providers receive the same sanitized JPEG bytes, but internal resizing/cropping differs (ConvNeXt resize236/center224).",
                "Latency excludes local model loading; a configured network timeout is not a guaranteed hard process cutoff.",
                "Missing usage or interrupted attempts may still incur charges. Cost estimate excludes cache discounts, tax and other tiers.",
            ]}


def render_report(report: dict) -> str:
    """Small aggregate Korean report with no individual rows or opaque source codes."""
    lines = ["# 사진 분석 비교 파일럿", "", f"평가: `{report['evaluation_id']}` / 실행: `{report['run_id']}`", "",
             f"대상 {report['eligible_photo_count']}장 · 기록 {report['recorded_photo_count']}장 · 기록된 참여자 그룹 {report['recorded_participant_groups']}개", "",
             "정확도 비교와 우승 모델 선택은 보류합니다. 공통 라벨·코드 정의와 독립적인 사람 평가가 필요합니다.", "",
             "| 처리 결과 | ConvNeXt | OpenAI |", "|---|---:|---:|"]
    for title, key in (("완료", "completed"), ("실패", "unavailable"), ("미기록/중단", "missing_or_interrupted")):
        lines.append(f"| {title} | {report['providers']['local'][key]} | {report['providers']['openai'][key]} |")
    lines.extend(["", f"OpenAI 거절: {report['providers']['openai']['refused']}건", ""])
    for key, label in (("local", "ConvNeXt 8개 코드"), ("openai", "OpenAI 5개 관찰")):
        value = report["providers"][key]
        timing = value["latency"]
        agreement = value["within_participant_capture_agreement"]
        median = "미측정" if timing["median_ms"] is None else f"{timing['median_ms']}ms"
        p95 = "미측정" if timing["p95_ms"] is None else f"{timing['p95_ms']}ms"
        exact = agreement["mean_participant_exact_agreement"]
        exact_text = "미측정" if exact is None else f"{exact:.1%}"
        lines.append(f"- {label}: 기록된 요청 중앙 시간 {median} / p95 {p95}; 반복 비교 그룹 {agreement['participant_groups_compared']}개, 사진 쌍 {agreement['capture_pairs']}개, 그룹별 평균 완전 일치 {exact_text}")
    usage = report["providers"]["openai"]
    cost = usage["estimated_uncached_usd_for_known_usage"]
    cost_text = "미상" if cost is None else f"USD {cost:.8f}"
    journal = report.get("attempt_journal")
    if journal is not None:
        lines.extend(["", f"외부 시도 기록: 요청 전 기록 {journal['claimed']}건, 종료 기록 {journal['finished']}건, 종료 미확인 {journal['uncertain']}건. 자동 재시도는 허용되지 않습니다."])
    lines.extend(["", f"확인된 사용량의 표준 비캐시 요금 추정: {cost_text} (요금 확인일 {PRICE_DATE}).",
                  "사용량을 받지 못한 요청·중단된 요청의 비용은 미상이며 0으로 간주하지 않습니다. 실제 청구는 제공업체에서 확인하세요.", "",
                  "반복 일치는 정확도가 아닙니다. 8개 코드와 5개 관찰은 차원과 포함되는 사진 쌍이 달라 두 비율을 직접 비교할 수 없습니다. 판단 불가·불확실은 OpenAI 반복 일치 계산에서 제외하며 전체 항목별 건수는 summary.json에 남습니다. 같은 참여자의 사진을 독립 표본으로 세지 않습니다.", "",
                  "동일한 정제 JPEG를 사용하지만 ConvNeXt의 224 중앙 자르기와 OpenAI 내부 처리는 다릅니다. 수분·장벽·질환·성분 효능·안전성을 검증하지 않습니다.", "",
                  "이 보고서는 키오스크 분석 제공업체나 성분·매장 제품 추천을 변경하지 않습니다.", ""])
    return "\n".join(lines)
