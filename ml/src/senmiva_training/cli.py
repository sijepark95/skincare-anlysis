"""Explicit application commands; training adapters load only when requested."""

import argparse
import json
import os
from pathlib import Path

from .workspace import default_workspace, private_output, read_registry, register_dataset

SAFE_FAILURES = {
    "Exact image duplication crosses training and validation; preparation stopped.": (
        "split_overlap", "Identical photos cross the source splits. Review the audit; an explicit --cross-split-policy exclude-all excludes every shared photo from both prepared partitions without changing source files."
    ),
    "Prepared manifests are immutable; choose a new output directory.": (
        "manifest_exists", "This manifest is already prepared. Choose a new --name."
    ),
    "Choose a new output directory; existing experiments are never overwritten.": (
        "run_exists", "This experiment already exists. Choose a new --run."
    ),
    "CUDA is unavailable. Check the offline PyTorch CUDA installation, or select cpu.": (
        "cuda_unavailable", "Run doctor to check the GPU environment, or explicitly select --device cpu."
    ),
    "Initialize the private dataset registry first; see ml/README.md.": (
        "registry_missing", "Initialize the private dataset registry first; see ml/README.md."
    ),
    "Source image changed after manifest preparation.": (
        "source_changed", "A source image has changed. Review the data and prepare a new audited manifest."
    ),
    "Random initialization requires unfreeze=True; a frozen random backbone is not a baseline.": (
        "invalid_random_test", "Synthetic random-init tests also require --unfreeze. Use pretrained weights for a research baseline."
    ),
}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Senmiva offline ConvNeXt research; never called by the kiosk.")
    result.add_argument("--workspace", type=Path)
    commands = result.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Record the source and user-confirmed permission privately.")
    init.add_argument("--source", type=Path, required=True)
    init.add_argument("--training-permitted", action="store_true")
    init.add_argument("--commercial-permitted", action="store_true")
    commands.add_parser("doctor", help="Check the independent Python and GPU environment.")
    prepare = commands.add_parser("prepare", help="Audit pairs/hashes and write private pore-label manifests.")
    prepare.add_argument("--name", default="pores-full")
    prepare.add_argument("--limit", type=int, help="Maximum samples per publisher partition, for a smoke test.")
    prepare.add_argument("--seed", type=int, default=42)
    prepare.add_argument("--cross-split-policy", choices=("reject", "exclude-all"), default="reject", help="Default rejects shared photos; exclude-all removes every occurrence from both prepared partitions.")
    inspect = commands.add_parser("inspect", help="Decode a bounded sample and report aggregate image properties.")
    inspect.add_argument("--manifest", default="pores-clean-smoke")
    inspect.add_argument("--count", type=int, default=16)
    train = commands.add_parser("train", help="Run an explicitly requested offline experiment.")
    train.add_argument("--manifest", default="pores-clean-smoke")
    train.add_argument("--run", required=True)
    train.add_argument("--epochs", type=int, default=1)
    train.add_argument("--batch-size", type=int, default=8)
    train.add_argument("--learning-rate", type=float, default=1e-3)
    train.add_argument("--seed", type=int, default=42)
    train.add_argument("--max-steps", type=int)
    train.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    train.add_argument("--unfreeze", action="store_true")
    train.add_argument("--random-init", action="store_true", help="Synthetic plumbing tests only; no pretrained download.")
    evaluate = commands.add_parser("evaluate", help="Reload a saved checkpoint and reevaluate its validation manifest; never trains.")
    evaluate.add_argument("--manifest", default="pores-clean-full")
    evaluate.add_argument("--run", required=True)
    evaluate.add_argument("--checkpoint", choices=("best", "last"), default="best")
    evaluate.add_argument("--batch-size", type=int, default=8)
    evaluate.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    extract = commands.add_parser("extract", help="Safely expand all source archives into a fresh private local dataset.")
    extract.add_argument("--name", default="expanded-001")
    multitask_prepare = commands.add_parser("prepare-multitask", help="Audit an expanded dataset and prepare all supported visual-code targets.")
    multitask_prepare.add_argument("--extracted", default="expanded-001")
    multitask_prepare.add_argument("--name", default="skin-all-001")
    multitask_prepare.add_argument("--cross-split-policy", choices=("reject", "exclude-all"), default="reject")
    multitask_train = commands.add_parser("train-multitask", help="Train an explicit offline shared-backbone visual-code experiment.")
    multitask_train.add_argument("--manifest", default="skin-all-001")
    multitask_train.add_argument("--run", required=True)
    multitask_train.add_argument("--epochs", type=int, default=5)
    multitask_train.add_argument("--batch-size", type=int, default=8)
    multitask_train.add_argument("--learning-rate", type=float, default=1e-3)
    multitask_train.add_argument("--seed", type=int, default=42)
    multitask_train.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    multitask_train.add_argument("--unfreeze", action="store_true")
    multitask_evaluate = commands.add_parser("evaluate-multitask", help="Reevaluate an existing multitask checkpoint without training.")
    multitask_evaluate.add_argument("--manifest", default="skin-all-001")
    multitask_evaluate.add_argument("--run", required=True)
    multitask_evaluate.add_argument("--checkpoint", choices=("best", "last"), default="best")
    multitask_evaluate.add_argument("--batch-size", type=int, default=8)
    multitask_evaluate.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    recommendation_prepare = commands.add_parser("prepare-recommendation", help="Prepare private ingredient candidates from structured annotation inputs and silver mention labels.")
    recommendation_prepare.add_argument("--extracted", default="expanded-001")
    recommendation_prepare.add_argument("--name", default="ingredients-001")
    recommendation_prepare.add_argument("--min-support", type=int, default=10)
    code_support = commands.add_parser("prepare-code-support", help="Verify source-code categories against retained ingredient training profiles; never trains.")
    code_support.add_argument("--extracted", default="expanded-001")
    code_support.add_argument("--manifest", default="ingredients-001")
    code_support.add_argument("--name", default="ingredients-001-source-codes-v1")
    recommendation_train = commands.add_parser("train-recommendation", help="Train an explicit offline ingredient-candidate model; no hosted LLM.")
    recommendation_train.add_argument("--manifest", default="ingredients-001")
    recommendation_train.add_argument("--run", required=True)
    recommendation_train.add_argument("--epochs", type=int, default=20)
    recommendation_train.add_argument("--batch-size", type=int, default=64)
    recommendation_train.add_argument("--learning-rate", type=float, default=0.01)
    recommendation_train.add_argument("--seed", type=int, default=42)
    recommendation_train.add_argument("--device", choices=("auto", "cuda", "cpu"), default="cpu")
    recommendation_evaluate = commands.add_parser("evaluate-recommendation", help="Reevaluate a saved ingredient-candidate checkpoint without training.")
    recommendation_evaluate.add_argument("--manifest", default="ingredients-001")
    recommendation_evaluate.add_argument("--run", required=True)
    recommendation_evaluate.add_argument("--checkpoint", choices=("best", "last"), default="best")
    recommendation_evaluate.add_argument("--batch-size", type=int, default=64)
    recommendation_evaluate.add_argument("--device", choices=("auto", "cuda", "cpu"), default="cpu")
    photo_test = commands.add_parser("photo-test", help="Open a loopback-only personal-photo research tester; no training or saved photos.")
    photo_test.add_argument("--manifest", default="skin-all-001")
    photo_test.add_argument("--run", default="skin-all-head-001")
    photo_test.add_argument("--checkpoint", choices=("best", "last"), default="best")
    photo_test.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    photo_test.add_argument("--port", type=int, default=8765)
    for command, help_text in (
        ("comparison-init", "Create empty private external-photo evaluation and consent templates; never discovers photos."),
        ("comparison-check", "Validate explicitly listed independent consented photos without models, credentials or network."),
        ("comparison-run", "Default dry-run. Explicit --send-to-openai enables a bounded immutable paired research run."),
        ("comparison-report", "Write a private technical report; never computes cross-model accuracy."),
        ("comparison-purge", "Purge expired or revoked private generated results; preserve original photos and run tombstones."),
    ):
        comparison = commands.add_parser(command, help=help_text)
        comparison.add_argument("--name", required=True)
        if command in ("comparison-run", "comparison-report"):
            comparison.add_argument("--comparison-run", required=True)
        if command == "comparison-run":
            comparison.add_argument("--manifest", default="skin-all-001")
            comparison.add_argument("--model-run", default="skin-all-head-001")
            comparison.add_argument("--checkpoint", choices=("best", "last"), default="best")
            comparison.add_argument("--device", choices=("auto", "cpu", "cuda"), default="cpu")
            comparison.add_argument("--send-to-openai", action="store_true")
            comparison.add_argument("--openai-env-file", type=Path)
            comparison.add_argument("--max-api-calls", type=int, default=20)
        if command == "comparison-purge":
            comparison.add_argument("--all-results", action="store_true", help="Explicitly purge all generated individual outputs even before expiry or without readable consent records; never deletes originals.")
    return result


def child(workspace: Path, kind: str, name: str) -> Path:
    if not name or not name.isascii() or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in name):
        raise ValueError("Use a simple run or manifest name with letters, digits, hyphens or underscores.")
    return private_output(workspace / kind / name)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        workspace = private_output(args.workspace or default_workspace())
        os.environ["TORCH_HOME"] = str(workspace / "cache" / "torch")
        if args.command == "init":
            result = register_dataset(workspace, args.source, args.training_permitted, args.commercial_permitted)
        elif args.command == "doctor":
            import torch
            import torchvision
            result = {"torch": torch.__version__, "torchvision": torchvision.__version__, "cuda_available": torch.cuda.is_available(), "cuda_runtime": torch.version.cuda}
            if result["cuda_available"]:
                result["gpu"] = torch.cuda.get_device_name(0)
                result["vram_gib"] = round(torch.cuda.get_device_properties(0).total_memory / 2**30, 2)
        elif args.command.startswith("comparison-"):
            from . import vision_comparison as comparison
            if args.command == "comparison-init":
                result = comparison.comparison_init(workspace, args.name)
            elif args.command == "comparison-check":
                result = comparison.comparison_check(workspace, args.name)
            elif args.command == "comparison-run":
                result = comparison.comparison_run(
                    workspace, args.name, args.comparison_run, manifest=args.manifest,
                    model_run=args.model_run, checkpoint=args.checkpoint, device=args.device,
                    send_to_openai=args.send_to_openai, openai_env_file=args.openai_env_file,
                    max_api_calls=args.max_api_calls,
                )
            elif args.command == "comparison-report":
                result = comparison.comparison_report(workspace, args.name, args.comparison_run)
            else:
                result = comparison.comparison_purge(workspace, args.name, all_results=args.all_results)
        else:
            registry = read_registry(workspace)
            if args.command == "prepare":
                from .data import prepare_dataset
                result = prepare_dataset(Path(registry["root_path"]), child(workspace, "manifests", args.name), seed=args.seed, limit=args.limit, cross_split_policy=args.cross_split_policy)["summary"]
            elif args.command == "inspect":
                from .inspection import inspect_images
                result = inspect_images(child(workspace, "manifests", args.manifest), args.count)
            elif args.command == "evaluate":
                from .evaluation import evaluate_model
                result = evaluate_model(
                    child(workspace, "manifests", args.manifest), child(workspace, "runs", args.run),
                    checkpoint=args.checkpoint, device=args.device, batch_size=args.batch_size,
                )
            elif args.command == "extract":
                from .archives import extract_dataset
                result = extract_dataset(Path(registry["root_path"]), child(workspace, "datasets", args.name))
            elif args.command == "prepare-multitask":
                from .multitask_data import prepare_multitask
                result = prepare_multitask(
                    child(workspace, "datasets", args.extracted), child(workspace, "manifests", args.name),
                    cross_split_policy=args.cross_split_policy,
                )["summary"]
            elif args.command == "train-multitask":
                from .multitask_training import train_multitask
                result = train_multitask(
                    child(workspace, "manifests", args.manifest), child(workspace, "runs", args.run),
                    epochs=args.epochs, batch_size=args.batch_size, learning_rate=args.learning_rate,
                    seed=args.seed, device=args.device, unfreeze=args.unfreeze,
                )
            elif args.command == "evaluate-multitask":
                from .multitask_training import evaluate_multitask
                result = evaluate_multitask(
                    child(workspace, "manifests", args.manifest), child(workspace, "runs", args.run),
                    checkpoint=args.checkpoint, device=args.device, batch_size=args.batch_size,
                )
            elif args.command == "prepare-recommendation":
                from .recommendation import prepare_recommendation
                result = prepare_recommendation(
                    child(workspace, "datasets", args.extracted), child(workspace, "manifests", args.name),
                    min_support=args.min_support,
                )
            elif args.command == "train-recommendation":
                from .recommendation import train_recommendation
                result = train_recommendation(
                    child(workspace, "manifests", args.manifest), child(workspace, "runs", args.run),
                    epochs=args.epochs, batch_size=args.batch_size, learning_rate=args.learning_rate,
                    seed=args.seed, device=args.device,
                )
            elif args.command == "prepare-code-support":
                from .skin_code_contract import build_condition_support
                result = build_condition_support(
                    child(workspace, "datasets", args.extracted), child(workspace, "manifests", args.manifest),
                    child(workspace, "contracts", args.name).with_suffix(".json"),
                )
            elif args.command == "evaluate-recommendation":
                from .recommendation import evaluate_recommendation
                result = evaluate_recommendation(
                    child(workspace, "manifests", args.manifest), child(workspace, "runs", args.run),
                    checkpoint=args.checkpoint, device=args.device, batch_size=args.batch_size,
                )
            elif args.command == "photo-test":
                from .photo_server import serve_photo_test
                serve_photo_test(
                    child(workspace, "manifests", args.manifest), child(workspace, "runs", args.run),
                    checkpoint=args.checkpoint, device=args.device, port=args.port,
                )
                return 0
            else:
                from .trainer import train_model
                result = train_model(
                    child(workspace, "manifests", args.manifest), child(workspace, "runs", args.run),
                    epochs=args.epochs, batch_size=args.batch_size, learning_rate=args.learning_rate,
                    seed=args.seed, max_steps=args.max_steps, device=args.device,
                    pretrained=not args.random_init, unfreeze=args.unfreeze,
                )
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except Exception as exc:
        # Upstream IO/CUDA/Pillow errors can embed original image names or local paths.
        # Deliberately emit no traceback, data record, or credential-bearing exception.
        from .vision_comparison import ComparisonError
        code, message = ("comparison_not_ready", str(exc)) if isinstance(exc, ComparisonError) else SAFE_FAILURES.get(str(exc), ("offline_command_failed", "Offline command could not complete. Check dependencies, private paths, manifests, available memory and ml/README.md. No application data was changed."))
        print(json.dumps({"code": code, "error": message}))
        return 1
