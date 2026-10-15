# JARVIS — Local AI Assistant

*A personal Windows AI assistant inspired by Iron Man's JARVIS.*

## About the Project

JARVIS is a personal AI assistant designed to bring a futuristic, voice-controlled assistant to a Windows desktop. The goal is to build an assistant that can understand natural speech, respond naturally, interact with the computer, and provide useful information through an animated, futuristic interface.

The project began with inspiration from the Iron Man movies and has grown into an ongoing development project involving voice recognition, local AI, computer automation, system monitoring, and visual awareness.

## Download and Installation

### 1. Download JARVIS

1. Open this repository on GitHub.
2. Click the green **Code** button.
3. Select **Download ZIP**.
4. Extract the downloaded ZIP file to a folder on your Windows computer.

### 2. Start JARVIS

1. Open the extracted project folder.
2. Find and run `Start-Jarvis.bat`, if included in your version.
3. Wait for JARVIS and its required services to start.
4. Follow any setup instructions displayed by the application.

**Important:** Do not open `index.html` directly if your version requires the desktop application or local control bridge.

### 3. Required Software

Depending on the version and enabled features, JARVIS may require:

- **Windows** — the operating system for the assistant.
- **Ollama** — for local AI conversations.
- **A compatible AI model** — for Ollama to use.
- **Voice service configuration** — for spoken responses, if required.
- **A working microphone** — for voice commands.

Follow the setup instructions included with the project for any additional dependencies.

## How It Works

| Component | What it does |
|---|---|
| Voice recognition | Converts spoken commands into text. |
| Wake-word detection | Allows hands-free activation using a phrase such as "Hey Jarvis". |
| AI brain | Uses local AI through Ollama, when configured, to understand questions and generate responses. |
| Text-to-speech | Allows JARVIS to speak using the configured voice service. |
| Computer control | Opens supported applications, websites, files, and folders. |
| Browser and media control | Interacts with supported browser tabs and music players. |
| System monitoring | Displays system information such as CPU and RAM usage. |
| Visual awareness | Supports camera and screen recognition where implemented. |
| Assistant modes | Provides Music, Game, and Study modes where available. |
| Reminders and alarms | Supports time-based assistance where implemented. |
| Animated HUD | Displays assistant status, activity, and conversations. |

## Example Commands

Try these commands if the corresponding features are enabled:

- "Hey Jarvis"
- "Open Notepad"
- "Find my Roblox folder"
- "Open YouTube Music"
- "Enter study mode"
- "What can you help me with?"

Available commands depend on the features enabled in your version.

## Main Goals

- Understand natural voice commands and everyday conversation.
- Activate using a wake word.
- Respond using a configured AI voice.
- Use local AI for general questions and conversations.
- Open applications, websites, files, and folders.
- Control supported browser tabs and media players.
- Play and control music through voice commands.
- Monitor CPU and RAM usage.
- Support camera and screen recognition where possible.
- Provide reminders, alarms, and calendar-related functions.
- Support Music, Game, and Study modes.
- Maintain a futuristic animated HUD.

## Development Journey

1. **Initial inspiration** — The idea came from the JARVIS assistant in Iron Man.
2. **Feature planning** — Plan voice commands, computer controls, AI capabilities, and the interface.
3. **Core application** — Develop the main assistant interface and animated HUD.
4. **Computer integration** — Add browser control, application launching, media playback, and system monitoring.
5. **Voice improvements** — Improve speech recognition, noise filtering, and wake-word detection.
6. **Visual awareness** — Explore OpenCV, camera input, and screen recognition.
7. **Assistant modes** — Develop Music, Game, and Study modes, plus conversation follow-ups.
8. **Reliability improvements** — Address repeated speech, incorrect command routing, and voice feedback loops.
9. **Natural conversation** — Improve everyday responses, memory, and conversational understanding.
10. **Ongoing refinement** — Test features, fix bugs, and improve stability.

## Design Philosophy

- **Hands-free:** Voice is the main way to interact with JARVIS.
- **Natural:** Understand different ways of expressing the same request.
- **Local-first:** Use local processing where practical.
- **Responsive:** Provide clear feedback when commands are processed.
- **Modular:** Improve features without unnecessarily breaking other components.
- **Consistent:** Preserve the existing interface and working features during updates.

## Project Status

JARVIS is an ongoing development project. Features are being built, tested, and refined. A feature being planned or explored does not necessarily mean it is fully implemented or reliable.

Future development focuses on voice recognition, wake-word reliability, natural conversation, media control, visual awareness, and overall stability.

## Safety and Privacy

JARVIS may interact with local files, applications, a microphone, a camera, and external AI or voice services.

- Keep API keys and credentials out of source control.
- Never commit `.env` files containing secrets.
- Protect personal conversation logs and private configuration.
- Review permissions before enabling microphone, camera, or computer-control features.
- Understand which services process data locally and which may send data externally.

## Development Guidelines

- Back up the working project before significant changes.
- Preserve the existing interface and working features.
- Make focused changes instead of rewriting unrelated components.
- Test affected features after changes.
- Keep secrets, caches, generated files, and unnecessary large assets out of Git.
- Document whether features are planned, implemented, or verified.

## Vision

The long-term goal is to create a capable, personalized desktop assistant that combines voice interaction, AI reasoning, computer automation, system awareness, and a cinematic interface in one application.

**JARVIS is more than a basic voice-command script — it is an ongoing attempt to build a practical Windows AI assistant inspired by the idea of JARVIS.**

---

*Built and developed as a personal AI assistant project.*
