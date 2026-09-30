"""Score the exported eval corpus with a Hugging Face prompt-injection classifier.

    npx tsx evals/injection/run.ts --held-out --export
    python evals/injection/promptguard.py [model-id] [name] [--sample]

The default model is the bar R17 names, Llama Prompt Guard 2 86M, which is
gated: accept Meta's licence on its Hugging Face page and set HF_TOKEN first.
Any text-classification model with an injection label works the same way
(protectai/deberta-v3-base-prompt-injection-v2 is Apache-2.0 and ungated).

--sample scores only the documents in .cache/scores-jev.jsonl (the Jev run's
seeded sample), which keeps a CPU run to minutes and the comparison like for
like. Writes .cache/scores-<name>.jsonl, one {id, score, ms} per document, where
score is the malicious-class probability over the worst 512-token window
(Prompt Guard 2's context; its card says to split longer text and scan each
segment). run.ts picks the file up as another detector.

Needs: torch, transformers (and sentencepiece for DeBERTa tokenizers).
"""

import json
import os
import sys
import time

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
MODEL = sys.argv[1] if len(sys.argv) > 1 else "meta-llama/Llama-Prompt-Guard-2-86M"
NAME = sys.argv[2] if len(sys.argv) > 2 else "promptguard2-86m"
SAMPLE = None
if "--sample" in sys.argv:
    with open(os.path.join(CACHE, "scores-jev.jsonl")) as f:
        SAMPLE = {json.loads(line)["id"] for line in f if line.strip()}
WINDOW = 512

tokenizer = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForSequenceClassification.from_pretrained(MODEL)
model.eval()
labels = {v.lower(): k for k, v in model.config.id2label.items()}
positive = next(labels[k] for k in ("malicious", "injection", "label_1") if k in labels)


def score(text: str) -> float:
    ids = tokenizer(text, add_special_tokens=False)["input_ids"] or [tokenizer.unk_token_id]
    step = WINDOW - 2
    windows = [ids[i : i + step] for i in range(0, len(ids), step)]
    best = 0.0
    for window in windows:
        batch = tokenizer.build_inputs_with_special_tokens(window)
        with torch.no_grad():
            logits = model(input_ids=torch.tensor([batch])).logits
        best = max(best, torch.softmax(logits, dim=-1)[0, positive].item())
    return best


with open(os.path.join(CACHE, "corpus.jsonl")) as src, open(os.path.join(CACHE, f"scores-{NAME}.jsonl"), "w") as out:
    for line in src:
        doc = json.loads(line)
        if SAMPLE is not None and doc["id"] not in SAMPLE:
            continue
        t0 = time.perf_counter()
        s = score(doc["text"])
        out.write(json.dumps({"id": doc["id"], "score": s, "ms": (time.perf_counter() - t0) * 1000}) + "\n")
print(f"wrote .cache/scores-{NAME}.jsonl ({MODEL})")
