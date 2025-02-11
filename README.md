# Obsidian Sidekick

Sidekick lets you chat with your notes. A chatbot for Obsidian.md using semantic search and Retrieval-Augmented Generation (RAG).

## Using Sidekick

Sidekick uses OpenAI for creating embeddings and to power your conversations. You will need an OpenAI API key to use Sidekick.

If you'd like to use Sidekick during its alpha, contact [@adilmajid on Twitter](https://www.twitter.com/adilmajid) or [Telegram](https://t.me/adilmajid). Please note that Sidekick has only been tested on macOS and iOS so far.

## Roadmap

### Upcoming
- [ ] License key integration (LemonSqueezy?)
- [ ] Have a small check mark for “include open note in LLM context”
- [ ] Stop generating response from model
- [ ] Explore local LLM options
- [ ] Command for Sidekick to continue writing in your note

### Maybe later
- [ ] Create and save "profiles" for different system prompts
- [ ] Anthropic API support

### Known bugs
- None known currently

### Shipped
- [x] o3-mini integration
- [x] Give LLM basic context, including today's date
- [x] Don't auto-scroll
- [x] Suggested prompts appear in new conversations and user can customize them
- [x] (bug) Count of indexed notes can exceed total note count if notes are deleted
- [x] Access past conversations
- [x] Auto-title past conversations
- [x] Mobile support
- [x] Ability to turn model responses into new notes
- [x] Give the model ability to add to its own memory
- [x] Add a section for user to add personal details to provide to model as context
- [x] Allow user to modify system prompt
- [x] Update design to be more minimal + work with Obsidian theme colors

## Terms & Disclaimer

This plugin is provided as-is, with no guarantees. It’s experimental, so use it at your own risk. Keep in mind the LLM's responses might not always be accurate — double-check important info before relying on it.

By using this plugin, you agree that you’re responsible for how you use it.
