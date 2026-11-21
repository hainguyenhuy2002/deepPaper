export function directPrompt({ question, selection, selectionPage, replyExcerpt }) {
  const parts = []
  if (selection) parts.push('Selected PDF text' + (selectionPage ? ' (page ' + selectionPage + ')' : '') + ':\n' + selection)
  if (replyExcerpt) parts.push('Quoted reply:\n' + replyExcerpt)
  return parts.length ? [question, ...parts].join('\n\n') : question
}

export function directHistory(transcript) {
  let remaining = 280000
  const recent = []
  // Keep complete recent exchanges when rebuilding a provider thread.
  for (let i = transcript.length - 2; i >= 0; i -= 2) {
    const reader = transcript[i]
    const assistant = transcript[i + 1]
    const content = directPrompt({
      question: reader.content, selection: reader.pdfExcerpt,
      selectionPage: reader.page, replyExcerpt: reader.replyExcerpt
    })
    const length = content.length + assistant.content.length
    if (length > remaining) break
    recent.unshift({ role: 'user', content }, { role: 'assistant', content: assistant.content })
    remaining -= length
  }
  return recent
}

export function directMessages(transcript, thread) {
  const replay = directHistory(transcript)
  const valid = typeof thread?.id === 'string' && Number.isInteger(thread.through) &&
    thread.through >= 2 && thread.through <= transcript.length && thread.through % 2 === 0
  return {
    threadId: valid ? thread.id : undefined,
    pending: valid ? directHistory(transcript.slice(thread.through)) : replay,
    replay
  }
}
