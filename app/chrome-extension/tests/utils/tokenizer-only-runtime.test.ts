import { BertTokenizer, env } from "@xenova/transformers";
import { describe, expect, it } from "vitest";

const VOCAB = {
  "[PAD]": 0,
  "[UNK]": 1,
  "[CLS]": 2,
  "[SEP]": 3,
  "[MASK]": 4,
  query: 5,
  passage: 6,
  ":": 7,
  hello: 8,
  world: 9,
  quick: 10,
  brown: 11,
  fox: 12,
  jumps: 13,
  over: 14,
  lazy: 15,
  dog: 16,
  ".": 17,
} as const;

function createE5StyleTokenizer(): BertTokenizer {
  const tokenizerJson = {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: Object.entries(VOCAB)
      .filter(([token]) => token.startsWith("["))
      .map(([content, id]) => ({
        id,
        content,
        single_word: false,
        lstrip: false,
        rstrip: false,
        normalized: false,
        special: true,
      })),
    normalizer: {
      type: "BertNormalizer",
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: true,
    },
    pre_tokenizer: { type: "BertPreTokenizer" },
    post_processor: {
      type: "TemplateProcessing",
      single: [
        { SpecialToken: { id: "[CLS]", type_id: 0 } },
        { Sequence: { id: "A", type_id: 0 } },
        { SpecialToken: { id: "[SEP]", type_id: 0 } },
      ],
      pair: [
        { SpecialToken: { id: "[CLS]", type_id: 0 } },
        { Sequence: { id: "A", type_id: 0 } },
        { SpecialToken: { id: "[SEP]", type_id: 0 } },
        { Sequence: { id: "B", type_id: 1 } },
        { SpecialToken: { id: "[SEP]", type_id: 1 } },
      ],
      special_tokens: {
        "[CLS]": { id: "[CLS]", ids: [VOCAB["[CLS]"]], tokens: ["[CLS]"] },
        "[SEP]": { id: "[SEP]", ids: [VOCAB["[SEP]"]], tokens: ["[SEP]"] },
      },
    },
    decoder: { type: "WordPiece", prefix: "##", cleanup: true },
    model: {
      type: "WordPiece",
      unk_token: "[UNK]",
      continuing_subword_prefix: "##",
      max_input_chars_per_word: 100,
      vocab: VOCAB,
    },
  };
  const tokenizerConfig = {
    tokenizer_class: "BertTokenizer",
    model_max_length: 512,
    pad_token: "[PAD]",
    unk_token: "[UNK]",
    cls_token: "[CLS]",
    sep_token: "[SEP]",
    mask_token: "[MASK]",
    clean_up_tokenization_spaces: true,
  };

  return new BertTokenizer(tokenizerJson, tokenizerConfig);
}

function tensorNumbers(tensor: { data: BigInt64Array }): number[] {
  return Array.from(tensor.data, Number);
}

describe("Transformers.js tokenizer-only runtime patch", () => {
  it("does not expose an ONNX or remote WASM backend", () => {
    expect(env.backends.onnx).toEqual({});
    expect("wasm" in env.backends.onnx).toBe(false);
  });

  it("preserves the stock 2.17.2 E5-prefix token and Tensor surface", async () => {
    const output = await createE5StyleTokenizer()("query: hello world", {
      padding: true,
      truncation: true,
      max_length: 8,
      return_token_type_ids: false,
    });

    expect(tensorNumbers(output.input_ids)).toEqual([2, 5, 7, 8, 9, 3, 0, 0]);
    expect(tensorNumbers(output.attention_mask)).toEqual([
      1, 1, 1, 1, 1, 1, 0, 0,
    ]);
    expect(output).not.toHaveProperty("token_type_ids");
    expect(output.input_ids.dims).toEqual([1, 8]);
    expect(output.input_ids.type).toBe("int64");
    expect(output.input_ids.size).toBe(8);
    expect(output.input_ids.data).toBeInstanceOf(BigInt64Array);
    expect(Object.keys(output.input_ids)).toEqual([
      "dims",
      "type",
      "data",
      "size",
    ]);
  });

  it("preserves stock batch padding for query and passage prefixes", async () => {
    const output = await createE5StyleTokenizer()(
      ["query: hello", "passage: hello world"],
      {
        padding: true,
        truncation: true,
        max_length: 8,
        return_token_type_ids: false,
      },
    );

    expect(tensorNumbers(output.input_ids)).toEqual([
      2, 5, 7, 8, 3, 0, 0, 0, 2, 6, 7, 8, 9, 3, 0, 0,
    ]);
    expect(tensorNumbers(output.attention_mask)).toEqual([
      1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0,
    ]);
    expect(output.input_ids.dims).toEqual([2, 8]);
    expect(output.attention_mask.dims).toEqual([2, 8]);
  });

  it("preserves stock max-length truncation", async () => {
    const output = await createE5StyleTokenizer()(
      "query: hello world quick brown fox jumps over lazy dog.",
      {
        padding: true,
        truncation: true,
        max_length: 7,
        return_token_type_ids: false,
      },
    );

    expect(tensorNumbers(output.input_ids)).toEqual([2, 5, 7, 8, 9, 10, 11]);
    expect(tensorNumbers(output.attention_mask)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(output.input_ids.dims).toEqual([1, 7]);
  });
});
