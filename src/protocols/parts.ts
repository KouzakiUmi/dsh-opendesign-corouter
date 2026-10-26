/**
 * 消息内容的模态投影（Responses / Messages 共用）。
 *
 * 与 Chat Completions 的 `conversion.ts#parts` 保持同一语义：文本直出，可解析的图片变成
 * 图片 URL，无法解析或已 offload 的图片退化为命名占位文本，原始文件句柄直接拒绝。
 */

import { LlmError, textOnlyImageText, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';

/** 图片附件 → 请求体可用的 URL（通常是 data URL）。 */
export type ImageLookup = (ref: ImageAttachmentRef) => string | undefined;

/** 一段消息投影后的文本与图片。 */
export interface ProjectedContent {
  text: string;
  images: string[];
}

/**
 * 投影一个消息的文本与图片。
 *
 * @param blocks 消息内容块。
 * @param image 图片解析器；未提供时所有图片退化为占位文本。
 */
export function projectContent(blocks: readonly ContentBlock[], image?: ImageLookup): ProjectedContent {
  let text = '';
  const images: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text += block.text;
        break;
      case 'image': {
        const url = block.offloaded ? undefined : image?.(block.attachment);
        if (url) images.push(url);
        else text += `${text ? '\n' : ''}${textOnlyImageText(block.attachment)}`;
        break;
      }
      case 'file':
        throw new LlmError('原始文件未被宿主投影为文本句柄', 'UNSUPPORTED_OPTION');
      // 工具定义已由 Core 物化进 options.tools；工具更新块只对声明 in-history 的路由有意义。
      default:
        break;
    }
  }
  return { text, images };
}
