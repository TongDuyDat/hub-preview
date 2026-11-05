# Changelog

## Unreleased

- Bundle the shared MCP runtime for supported agent auto-registration.
- Apply proposals to disk immediately; Accept keeps code and Reject restores selected blocks.
- Send persistent review decisions to agents and require rereading affected files before further proposals.
- Display full project-relative file paths and clarify review actions.
- Add English-first documentation, Vietnamese translations, installation and publishing guides.


## 0.3.4

- Prefer the native inline diff when a file still has pending MCP review blocks; return to the original after the final decision.
- Keep file selection in the same editor group and avoid focus changes after navigation, typing, or a completed review.
- Add quick MCP setup for DeepSeek Harness and Oh My Pi, including isolated Oh My Pi profiles.
- Restore the compact file/block panel and Auto Save-safe per-block review.
- Restore the static GitHub Pages source and disable Jekyll processing.
- Publish VSIX and MCP tarballs through tagged GitHub Releases, with npm publication instructions.
