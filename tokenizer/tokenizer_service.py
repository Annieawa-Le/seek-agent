#!/usr/bin/env python3
"""
Tokenizer service for Seek Agent.

Reads JSON lines from stdin, outputs JSON lines to stdout.
Protocol:
  Input:  {"text": "some text to tokenize"}
  Output: {"tokens": 42, "error": null}

The process stays alive and processes requests one per line.
"""

import sys
import json
import os

try:
    import transformers
except ImportError:
    # Fallback: if transformers not available, use a rough estimate
    transformers = None


class TokenizerService:
    def __init__(self, model_dir: str):
        self.model_dir = model_dir
        self.tokenizer = None
        self._init_tokenizer()

    def _init_tokenizer(self):
        if transformers is None:
            print("WARNING: transformers not installed, using fallback estimation", file=sys.stderr)
            self.tokenizer = None
            return
        try:
            self.tokenizer = transformers.AutoTokenizer.from_pretrained(
                self.model_dir, trust_remote_code=True
            )
        except Exception as e:
            print(f"WARNING: failed to load tokenizer: {e}, using fallback", file=sys.stderr)
            self.tokenizer = None

    def count_tokens(self, text: str) -> int:
        if self.tokenizer is not None:
            tokens = self.tokenizer.encode(text)
            return len(tokens)
        else:
            # Fallback: estimate tokens (roughly 4 chars per token for English/Chinese mixed)
            return max(1, len(text) // 3)

    def run(self):
        sys.stdin.reconfigure(encoding='utf-8')
        sys.stdout.reconfigure(encoding='utf-8')

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
                text = request.get("text", "")
                token_count = self.count_tokens(text)
                response = {"tokens": token_count, "error": None}
            except Exception as e:
                response = {"tokens": 0, "error": str(e)}

            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deepseek_v3_tokenizer")
    service = TokenizerService(model_dir)
    service.run()
