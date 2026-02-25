/**
 * Text chunking utility
 * Based on semantic chunking strategy, splits long text into small chunks suitable for vectorization
 */

export interface TextChunk {
  text: string;
  source: string;
  index: number;
  wordCount: number;
}

export interface ChunkingOptions {
  maxWordsPerChunk?: number;
  overlapSentences?: number;
  minChunkLength?: number;
  includeTitle?: boolean;
}

export class TextChunker {
  private readonly defaultOptions: Required<ChunkingOptions> = {
    maxWordsPerChunk: 80,
    overlapSentences: 1,
    minChunkLength: 20,
    includeTitle: true,
  };

  public chunkText(content: string, title?: string, options?: ChunkingOptions): TextChunk[] {
    const opts = { ...this.defaultOptions, ...options };
    const chunks: TextChunk[] = [];

    if (opts.includeTitle && title?.trim() && title.trim().length > 5) {
      chunks.push({
        text: title.trim(),
        source: 'title',
        index: 0,
        wordCount: title.trim().split(/\s+/).length,
      });
    }

    const cleanContent = content.trim();
    if (!cleanContent) {
      return chunks;
    }

    const sentences = this.splitIntoSentences(cleanContent);

    if (sentences.length === 0) {
      return this.fallbackChunking(cleanContent, chunks, opts);
    }

    const hasLongSentences = sentences.some(
      (s: string) => s.split(/\s+/).length > opts.maxWordsPerChunk,
    );

    if (hasLongSentences) {
      return this.mixedChunking(sentences, chunks, opts);
    }

    return this.groupSentencesIntoChunks(sentences, chunks, opts);
  }

  private splitIntoSentences(content: string): string[] {
    const processedContent = content
      .replace(/([。！？])\s*/g, '$1\n')
      .replace(/([.!?])\s+(?=[A-Z])/g, '$1\n')
      .replace(/([.!?]["'])\s+(?=[A-Z])/g, '$1\n')
      .replace(/([.!?])\s*$/gm, '$1\n')
      .replace(/([。！？][""])\s*/g, '$1\n')
      .replace(/\n\s*\n/g, '\n');

    const sentences = processedContent
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 15);

    if (sentences.length < 3 && content.length > 500) {
      return this.aggressiveSentenceSplitting(content);
    }

    return sentences;
  }

  private aggressiveSentenceSplitting(content: string): string[] {
    const sentences = content
      .replace(/([.!?。！？])/g, '$1\n')
      .replace(/([;；:：])/g, '$1\n')
      .replace(/([)）])\s*(?=[\u4e00-\u9fa5A-Z])/g, '$1\n')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 15);

    const maxWordsPerChunk = 80;
    const finalSentences: string[] = [];

    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);
      if (words.length <= maxWordsPerChunk) {
        finalSentences.push(sentence);
      } else {
        const overlapWords = 5;
        for (let i = 0; i < words.length; i += maxWordsPerChunk - overlapWords) {
          const chunkWords = words.slice(i, i + maxWordsPerChunk);
          const chunkText = chunkWords.join(' ');
          if (chunkText.length > 15) {
            finalSentences.push(chunkText);
          }
        }
      }
    }

    return finalSentences;
  }

  /**
   * Group sentences into chunks
   */
  private groupSentencesIntoChunks(
    sentences: string[],
    existingChunks: TextChunk[],
    options: Required<ChunkingOptions>,
  ): TextChunk[] {
    const chunks = [...existingChunks];
    let chunkIndex = chunks.length;

    let i = 0;
    while (i < sentences.length) {
      let currentChunkText = '';
      let currentWordCount = 0;
      let sentencesUsed = 0;

      while (i + sentencesUsed < sentences.length && currentWordCount < options.maxWordsPerChunk) {
        const sentence = sentences[i + sentencesUsed];
        const sentenceWords = sentence.split(/\s+/).length;

        if (currentWordCount + sentenceWords > options.maxWordsPerChunk && currentWordCount > 0) {
          break;
        }

        currentChunkText += (currentChunkText ? ' ' : '') + sentence;
        currentWordCount += sentenceWords;
        sentencesUsed++;
      }

      if (currentChunkText.trim().length > options.minChunkLength) {
        chunks.push({
          text: currentChunkText.trim(),
          source: `content_chunk_${chunkIndex}`,
          index: chunkIndex,
          wordCount: currentWordCount,
        });
        chunkIndex++;
      }

      i += Math.max(1, sentencesUsed - options.overlapSentences);
    }
    return chunks;
  }

  /**
   * Mixed chunking method (handles long sentences)
   */
  private mixedChunking(
    sentences: string[],
    existingChunks: TextChunk[],
    options: Required<ChunkingOptions>,
  ): TextChunk[] {
    const chunks = [...existingChunks];
    let chunkIndex = chunks.length;

    for (const sentence of sentences) {
      const sentenceWords = sentence.split(/\s+/).length;

      if (sentenceWords <= options.maxWordsPerChunk) {
        chunks.push({
          text: sentence.trim(),
          source: `sentence_chunk_${chunkIndex}`,
          index: chunkIndex,
          wordCount: sentenceWords,
        });
        chunkIndex++;
      } else {
        const words = sentence.split(/\s+/);
        for (let i = 0; i < words.length; i += options.maxWordsPerChunk) {
          const chunkWords = words.slice(i, i + options.maxWordsPerChunk);
          const chunkText = chunkWords.join(' ');

          if (chunkText.length > options.minChunkLength) {
            chunks.push({
              text: chunkText,
              source: `long_sentence_chunk_${chunkIndex}_part_${Math.floor(i / options.maxWordsPerChunk)}`,
              index: chunkIndex,
              wordCount: chunkWords.length,
            });
          }
        }
        chunkIndex++;
      }
    }

    return chunks;
  }

  /**
   * Fallback chunking (when sentence splitting fails)
   */
  private fallbackChunking(
    content: string,
    existingChunks: TextChunk[],
    options: Required<ChunkingOptions>,
  ): TextChunk[] {
    const chunks = [...existingChunks];
    let chunkIndex = chunks.length;

    const paragraphs = content
      .split(/\n\s*\n/)
      .filter((p) => p.trim().length > options.minChunkLength);

    if (paragraphs.length > 1) {
      paragraphs.forEach((paragraph, index) => {
        const cleanParagraph = paragraph.trim();
        if (cleanParagraph.length > 0) {
          const words = cleanParagraph.split(/\s+/);
          const maxWordsPerChunk = 150;

          for (let i = 0; i < words.length; i += maxWordsPerChunk) {
            const chunkWords = words.slice(i, i + maxWordsPerChunk);
            const chunkText = chunkWords.join(' ');

            if (chunkText.length > options.minChunkLength) {
              chunks.push({
                text: chunkText,
                source: `paragraph_${index}_chunk_${Math.floor(i / maxWordsPerChunk)}`,
                index: chunkIndex,
                wordCount: chunkWords.length,
              });
              chunkIndex++;
            }
          }
        }
      });
    } else {
      const words = content.trim().split(/\s+/);
      const maxWordsPerChunk = 150;

      for (let i = 0; i < words.length; i += maxWordsPerChunk) {
        const chunkWords = words.slice(i, i + maxWordsPerChunk);
        const chunkText = chunkWords.join(' ');

        if (chunkText.length > options.minChunkLength) {
          chunks.push({
            text: chunkText,
            source: `content_chunk_${Math.floor(i / maxWordsPerChunk)}`,
            index: chunkIndex,
            wordCount: chunkWords.length,
          });
          chunkIndex++;
        }
      }
    }

    return chunks;
  }
}
