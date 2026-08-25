/**
 * Parse an inbound `body.quote` block into a placeholder text plus, when the
 * quote carries a downloadable media handle, the download parameters.
 *
 * Why this matters: in a GROUP, WeCom does not push direct file/image
 * messages to the bot at all ("single-chat only"). The only way a group file
 * reaches the bot is when a user replies-to that file/image AND @-mentions
 * the bot — in which case the real downloadable handle rides along on
 * `body.quote`:
 *
 *   body.quote = { msgtype: 'file', file: { url: 'https://...cos...?sign=...',
 *                                            aeskey: '<base64>' } }
 *   body.quote = { msgtype: 'image', image: { url, aeskey } }
 *
 * The previous behavior turned these into a bare `[file message]` / `[image]`
 * placeholder and discarded the url/aeskey, so the file was never delivered.
 *
 * This helper decides between:
 *   - `media`: a downloadable file/image (url present) -> caller downloads it
 *     via downloadIncomingMedia and forwards it as the message media.
 *   - `placeholder` only: text quotes (content extracted), voice/video quotes
 *     (transcription-only / no url), mixed quotes, and file/image quotes with
 *     no url -> keep the informative placeholder, no download.
 *
 * Returns: { placeholder: string, media: { type, url, aesKey, filename } | null }
 * The caller replaces `placeholder` with an informative label (e.g.
 * `[quoted file: <name>]`) once the download succeeds.
 */
export function parseQuote(quote) {
  if (!quote || typeof quote !== 'object') {
    return { placeholder: '', media: null };
  }

  switch (quote.msgtype) {
    case 'text':
      return { placeholder: quote.text?.content || '', media: null };

    case 'file': {
      const file = quote.file || {};
      const name = file.filename || 'unknown';
      if (file.url) {
        return {
          placeholder: `[file: ${name}]`,
          media: {
            type: 'file',
            url: file.url,
            aesKey: file.aeskey || '',
            filename: file.filename || ''
          }
        };
      }
      return { placeholder: `[file: ${name}]`, media: null };
    }

    case 'image': {
      const image = quote.image || {};
      if (image.url) {
        return {
          placeholder: '[image]',
          media: {
            type: 'image',
            url: image.url,
            aesKey: image.aeskey || '',
            filename: image.filename || ''
          }
        };
      }
      return { placeholder: '[image]', media: null };
    }

    case 'mixed': {
      const items = quote.mixed?.msg_item || quote.mixed?.items || [];
      const placeholder = items
        .map((i) => (i.msgtype === 'text' ? (i.text?.content || '') : `[${i.msgtype}]`))
        .join(' ');
      return { placeholder, media: null };
    }

    default:
      // voice (transcription only, no url), video, and any unknown type keep
      // the informative placeholder and are never downloaded.
      return { placeholder: `[${quote.msgtype || 'unknown'} message]`, media: null };
  }
}

/**
 * Informative label for a successfully downloaded quoted media file.
 */
export function quotedMediaLabel(type, filename) {
  const name = filename || 'unknown';
  return type === 'image' ? `[quoted image: ${name}]` : `[quoted file: ${name}]`;
}

/**
 * Resolve a quote into the `<replying-to>` text and, when the quote carried a
 * downloadable file/image, the local media path to forward.
 *
 * The download side effect is injected so the caller supplies the real
 * network+decrypt helper (downloadIncomingMedia) and this stays unit-testable.
 * Best-effort: a download that returns null or throws falls back to the
 * placeholder and never propagates the error.
 *
 * @param {object} quote                 body.quote frame
 * @param {object} opts
 * @param {(media) => Promise<{path,filename}|null>} opts.download  downloader
 * @param {string} [opts.ownMediaPath]   media the message itself already carries
 * @param {(media, err) => void} [opts.onError]  called on download failure
 * @returns {Promise<{ quotedContent: string, mediaPath: string }>}
 */
export async function resolveQuote(quote, { download, ownMediaPath = '', onError } = {}) {
  const { placeholder, media } = parseQuote(quote);
  let quotedContent = placeholder;
  let mediaPath = ownMediaPath || '';

  if (media?.url && typeof download === 'function') {
    try {
      const downloaded = await download(media);
      if (downloaded) {
        // Only claim the message media slot if the message carried none.
        if (!mediaPath) mediaPath = downloaded.path;
        quotedContent = quotedMediaLabel(media.type, downloaded.filename);
      }
    } catch (err) {
      if (typeof onError === 'function') onError(media, err);
      // Keep the placeholder set above.
    }
  }

  return { quotedContent, mediaPath };
}
