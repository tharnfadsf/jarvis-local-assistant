# JARVIS — Local AI Assistant

*A personal Windows AI assistant inspired by the JARVIS system from Iron Man.*

## About the Project

JARVIS is a personal AI assistant project designed to bring a futuristic, voice-controlled assistant to a Windows desktop. Inspired by the technology shown in the Iron Man movies, the goal is to build an assistant that can understand natural speech, respond naturally, interact with the computer, and provide useful information through a futuristic animated interface.

The project started with an idea inspired by the movies and developed into a larger system involving voice recognition, local AI, computer control, system monitoring, and visual interaction.

The main goal is to make JARVIS feel less like a basic voice-command program and more like a helpful desktop companion.

## Main Goals

- Understand natural voice commands and everyday conversation.
- Activate using a wake word such as "Jarvis" or "Hey Jarvis".
- Respond using a configured AI voice.
- Use local AI for general questions and conversations.
- Open applications, websites, files, and folders.
- Control browser tabs and interact with supported media players.
- Play and control music through voice commands.
- Monitor system information such as CPU and RAM usage.
- Use a camera and screen recognition to understand visual information locally where supported.
- Provide reminders, alarms, and calendar-related features.
- Support dedicated Music, Game, and Study modes.
- Maintain a futuristic animated HUD while keeping the interface clear and functional.

## Features and Technologies

The project has explored or integrated the following areas. Availability and reliability may vary as development continues.

| Area | Purpose |
|---|---|
| Voice recognition | Convert spoken commands into text |
| Wake-word detection | Allow hands-free activation |
| Voice gate and noise filtering | Improve detection of speech in noisy environments |
| Text-to-speech | Let JARVIS speak responses using the configured voice |
| Local AI | Handle general questions and more flexible conversations |
| Computer automation | Launch applications, websites, files, and supported actions |
| Browser and media control | Manage supported tabs and music playback |
| System monitoring | Display CPU and memory usage |
| OpenCV and visual recognition | Support camera-based visual features |
| Screen recognition | Read and interpret supported on-screen content |
| Reminders and alarms | Provide time-based assistance |
| Animated HUD | Display assistant status, activity, and conversations |

## Development Journey

The project follows an iterative development process:

1. **Initial inspiration** — The idea came from the JARVIS assistant in Iron Man.
2. **Feature planning** — Define the desired voice commands, computer controls, AI capabilities, and interface.
3. **Core application** — Build the main assistant interface and animated HUD.
4. **Computer integration** — Add browser control, application launching, media playback, and system monitoring.
5. **Voice improvements** — Work on speech recognition, noise filtering, wake-word detection, and clearer transcription.
6. **Visual awareness** — Explore OpenCV, camera input, and screen recognition.
7. **Assistant modes** — Develop Music, Game, and Study modes, plus follow-up conversations.
8. **Reliability improvements** — Address repeated speech, incorrect command routing, voice feedback loops, and other bugs.
9. **Natural conversation** — Improve everyday responses, memory, and the assistant's ability to follow a conversation.
10. **Ongoing refinement** — Test existing functionality and improve features while preserving the established interface.

## Design Philosophy

JARVIS is intended to be:

- **Hands-free:** Voice should be the main way to interact with the assistant.
- **Natural:** It should understand different ways of expressing the same request.
- **Local-first:** Use local processing where practical, with external services only where needed.
- **Responsive:** Commands should be handled clearly, with useful feedback.
- **Modular:** Features should be improved without unnecessarily breaking other parts of the application.
- **Consistent:** Preserve the existing interface and working features during updates.

## Project Status

JARVIS is an ongoing development project. Features are being built, tested, and refined over time. A feature being planned or explored does not necessarily mean it is fully implemented or reliable yet.

Future development focuses on improving voice recognition, wake-word reliability, natural conversation, media control, visual awareness, and overall stability.

## Safety and Privacy

JARVIS may interact with local files, applications, a microphone, a camera, and external AI or voice services.

- Keep API keys and credentials out of source control.
- Store private configuration and personal data locally where appropriate.
- Review permissions before enabling microphone, camera, or computer-control features.
- Understand which features use local processing and which send data to external services.

## Development Principles

To keep the project stable:

- Back up the current working version before making significant changes.
- Preserve the existing UI and established behavior unless a change is explicitly requested.
- Make focused changes instead of rewriting unrelated components.
- Test affected features after changes.
- Keep secrets, caches, generated files, and unnecessary large assets out of Git.

## Vision

The long-term vision is to create a capable, personalized desktop assistant that combines voice interaction, AI reasoning, computer automation, system awareness, and a cinematic interface in one application.

**This is more than a voice-command script — it is an ongoing attempt to build a practical, local Windows assistant inspired by the idea of JARVIS.**

---

*Built and developed as a personal AI assistant project.*
