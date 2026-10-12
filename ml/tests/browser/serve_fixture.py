"""Synthetic browser-test provider; does not load checkpoints or train."""
from senmiva_training.photo_inference import LABELS, MODE
from senmiva_training.multitask_data import TARGETS
from senmiva_training.photo_server import create_photo_server


class SyntheticPredictor:
    def metadata(self):
        return {"schema_version": 1, "mode": MODE, "model_run": "synthetic-ui-fixture",
                "checkpoint": "best", "checkpoint_epoch": 1, "device": "cpu",
                "max_image_bytes": 10 * 1024 * 1024, "min_image_edge": 224, "max_decoded_pixels": 25_000_000,
                "targets": [{"key": key, "label": LABELS[key], "codes": list(codes)} for key, codes in TARGETS.items()],
                "warnings": ["Synthetic browser test, not a trained model."]}

    def predict_image(self, image_bytes):
        return {"schema_version": 1, "mode": MODE,
                "heads": [{"key": key, "label": LABELS[key], "predicted_code": codes[0],
                           "probabilities": [{"code": code, "probability": 1 / len(codes)} for code in codes]}
                          for key, codes in TARGETS.items()]}


if __name__ == "__main__":
    server = create_photo_server(SyntheticPredictor(), port=8876)
    print("Synthetic photo UI fixture ready at http://127.0.0.1:8876", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
