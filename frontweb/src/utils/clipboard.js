function legacyCopy(text, documentRef) {
  if (!documentRef?.body || typeof documentRef.createElement !== 'function' || typeof documentRef.execCommand !== 'function') {
    throw new Error('Clipboard copy is unavailable')
  }

  const textarea = documentRef.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  documentRef.body.appendChild(textarea)

  try {
    textarea.focus()
    textarea.select()
    if (!documentRef.execCommand('copy')) throw new Error('Copy command was rejected')
  } finally {
    textarea.remove()
  }
}

export async function copyText(text, environment = {}) {
  const navigatorRef = environment.navigator ?? globalThis.navigator
  const documentRef = environment.document ?? globalThis.document
  const value = String(text || '')

  if (typeof navigatorRef?.clipboard?.writeText === 'function') {
    try {
      await navigatorRef.clipboard.writeText(value)
      return
    } catch (_) {
      // Clipboard API can be present but denied; ordinary HTTP still gets the legacy path.
    }
  }

  legacyCopy(value, documentRef)
}
