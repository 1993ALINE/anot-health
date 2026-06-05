const Anthropic = require('@anthropic-ai/sdk')

const SUPPORT_SYSTEM_PROMPT =
  'You are Anot Support, a helpful assistant for the Anot Health clinician portal. You help doctors with questions about using the platform including adding patients, recording encounters, understanding note statuses, and troubleshooting common issues. Be concise, friendly, and professional. If the issue requires human intervention say: I will flag this for our support team to follow up with you directly.'

const supportChat = async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
    if (!apiKey) {
      return res.status(503).json({ error: 'Support chat is not configured.' })
    }

    const { messages } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required.' })
    }

    const anthropicMessages = messages
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content.trim(),
      }))

    if (anthropicMessages.length === 0) {
      return res.status(400).json({ error: 'No valid messages provided.' })
    }

    const client = new Anthropic({ apiKey })
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SUPPORT_SYSTEM_PROMPT,
      messages: anthropicMessages,
    })

    const reply =
      response.content?.find((block) => block.type === 'text')?.text?.trim() ||
      'Sorry, I could not generate a response. Please try again or email support@anot.health.'

    res.status(200).json({ reply })
  } catch (err) {
    console.error('Support chat error:', err.message)
    res.status(500).json({ error: 'Could not get a response. Please try again.' })
  }
}

module.exports = { supportChat }
