# Obsidian Sidekick

Sidekick lets you chat with your notes. A chatbot for Obsidian.md using semantic search and Retrieval-Augmented Generation (RAG).

## Using Sidekick

Sidekick uses OpenAI for creating embeddings and to power your conversations. You will need an OpenAI API key to use Sidekick.

If you'd like to use Sidekick during its alpha, contact [@adilmajid on Twitter](https://www.twitter.com/adilmajid) or [Telegram](https://t.me/adilmajid).

## Roadmap

### Upcoming
- [ ] Create and save "profiles" for different system prompts
- [ ] Have a small check mark for “include open note in LLM context”
- [ ] Stop generating response from model
- [ ] Don't auto-scroll
- [ ] Give LLM basic context, including today's date
- [ ] Anthropic API support
- [ ] Explore local LLM options
- [ ] `+++` for Sidekick to continue writing in your note

### Known bugs
- None currently

### Shipped
- [x] (bug) Count of indexed notes can exceed total note count if notes are deleted
- [x] Access past conversations
- [x] Auto-title past conversations
- [x] Mobile support
- [x] Ability to turn model responses into new notes
- [x] Give the model ability to add to its own memory
- [x] Add a section for user to add personal details to provide to model as context
- [x] Allow user to modify system prompt
