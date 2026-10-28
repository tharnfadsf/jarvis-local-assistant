# JARVIS — Local AI Assistant

*A personal desktop AI assistant inspired by Iron Man's JARVIS.*

**Created and developed by Tharn.**

## About the Project

JARVIS is a personal AI assistant designed to bring a futuristic, voice-controlled assistant to the desktop. The goal is to build an assistant that understands natural speech, responds naturally, interacts with the computer, and provides useful information through an animated, futuristic interface.

The project began with inspiration from the Iron Man movies and has grown into an ongoing development project involving voice recognition, AI conversations, computer automation, system monitoring, and visual awareness.

The original project focuses on Windows. JARVIS Share aims to make the experience available on **Windows, macOS, and Arch Linux**, with platform-specific implementations and setup instructions where supported.

Features and platform compatibility depend on the version being used. See the release notes and feature-support information for verified availability.

## Download and Installation

### 1. Download JARVIS

1. Open the official JARVIS project or release page.
2. Choose the package matching your operating system and supported CPU architecture.
3. Download the available release.
4. Follow the installation instructions provided for that package.

Available formats may include:

- **Windows:** a supported installer or downloadable application package.
- **macOS:** a supported application package for the listed macOS versions and architectures.
- **Arch Linux:** a native Arch package, with a portable AppImage option where available and supported.

Only use download formats that are actually published for the release. Check the release notes for exact system requirements and compatibility.

### 2. Start JARVIS

1. Open the installed application or launch it using the instructions for your downloaded package.
2. Follow the first-run setup wizard, if included in your version.
3. Configure your preferred AI provider and optional voice services.
4. Allow the operating system to request microphone, camera, or other permissions when needed.
5. Complete the connection tests and start using JARVIS.

**Important:** Do not open `index.html` directly if your version requires the desktop application or local control bridge.

A supported setup wizard should let users configure their own settings through the interface rather than manually editing project files.

### 3. Required Software

Depending on the version and enabled features, JARVIS may require:

- **A supported desktop operating system:** Windows, macOS, or Arch Linux, according to the downloaded release.
- **Ollama:** optional local AI runtime when local inference is supported and selected.
- **A compatible AI model:** needed when using Ollama for AI conversations.
- **AI API credentials:** needed only when an external API provider is selected.
- **Voice-service configuration:** required for external speech services where applicable.
- **A working microphone:** needed for voice recognition.
- **Optional permissions and dependencies:** required by supported camera, screen-analysis, browser, and computer-control features.

Follow the setup instructions for your particular release. Optional integrations should not be required when the corresponding feature is disabled.

## Optional Integrations

### Local AI with Ollama

When supported, Ollama allows JARVIS to use a compatible AI model running locally on your computer.

This can reduce reliance on external AI services, although performance depends on the selected model, system hardware, memory, and configuration.

### External AI API

JARVIS may also support an external AI API provider, such as an implemented OpenAI-compatible provider.

Depending on the selected provider and configuration, an external API can supply conversation and reasoning capabilities alongside or instead of local AI.

Users must configure their own credentials. Availability, supported models, rate limits, and charges depend on the provider.

**Privacy note:** Messages sent to an external AI provider may be processed on that provider's servers. Review the provider's policies and configure the application according to your privacy preferences.

### Clicky and screen-aware interaction

Where implemented, Clicky can provide screen-aware computer interaction, such as clicking, moving the cursor, hovering, scrolling, or interacting with visible interface elements.

These capabilities depend on the operating system, permissions, integration, and the version being used.

### Voice services

JARVIS can use its configured text-to-speech provider where supported. An external voice service, such as a configured Fish Audio integration, may require the user's own credentials.

Check the setup screen to see which voice providers are supported by your release.

## How It Works

| Component | What it does |
|---|---|
| Voice recognition | Converts spoken commands into text. |
| Wake-word detection | Allows hands-free activation using a phrase such as "Hey Jarvis," where supported. |
| Push-to-Talk | Lets the user activate speech capture manually and submit the resulting transcript to the conversation system. |
| AI brain | Uses a configured local model or supported external AI provider to understand questions and generate responses. |
| Conversation context | Uses relevant conversation history to help JARVIS understand follow-up questions and ongoing discussions. |
| Text-to-speech | Allows JARVIS to speak using the configured voice service. |
| Computer control | Opens supported applications, websites, files, and folders. |
| Browser and media control | Interacts with supported browser tabs and media players. |
| System monitoring | Displays system information such as CPU and memory usage. |
| Visual awareness | Supports camera and screen recognition where implemented and permitted. |
| Assistant modes | Provides Music, Game, and Study modes where available. |
| Reminders and alarms | Supports time-based assistance where implemented. |
| Animated HUD | Displays assistant status, activity, and conversations. |
| Optional integrations | Adds supported capabilities according to the selected configuration and platform. |

## Example Commands and What They Do

Use these examples when the corresponding feature is enabled in your version. Natural-language understanding may accept different wording for the same action.

### General conversation

| Example command | What it does |
|---|---|
| "Hey Jarvis" | Activates JARVIS through the configured wake-word system, where supported. |
| "Hi, Jarvis!" | Starts a greeting or conversation when JARVIS is already active. |
| "What can you help me with?" | Asks JARVIS to explain its available capabilities. |
| "Explain that more simply." | Requests a clearer explanation of the previous answer. |
| "Why is that?" | Asks a contextual follow-up about the previous discussion. |
| "What do you mean?" | Requests clarification of the previous answer. |
| "Tell me more about that." | Requests more detail about the current topic. |
| "Let's try another approach." | Continues the conversation while asking for a different approach. |
| "Thanks, Jarvis." | Responds naturally to the current conversation. |

### Voice and conversation controls

| Example command or action | What it does |
|---|---|
| Say "Hey Jarvis" | Activates the configured wake-word system, where supported. |
| Press the Push-to-Talk button and speak | Captures speech, transcribes it, and sends the transcript through the normal conversation pipeline. |
| "Stop" | Stops current speech or interrupts a response where supported. |
| "Bye bye" | Ends the current conversational session where that behavior is implemented. |
| Use the existing Clear Conversation control | Clears the active conversation according to the installed version's behavior. |

Push-to-Talk is intended to capture and transcribe the user's speech before passing it to the shared conversation system. It should not require the user to manually copy a transcript or submit the same message twice.

### Opening applications and websites

| Example command | What it does |
|---|---|
| "Open Notepad" | Opens Notepad on a supported Windows installation. |
| "Open Calculator" | Opens the available calculator application where supported. |
| "Open Safari" | Opens Safari on a compatible macOS installation. |
| "Open my browser" | Opens the configured or available supported browser. |
| "Open Gmail" | Opens Gmail in a supported browser or application workflow. |
| "Open ChatGPT" | Opens ChatGPT using the supported application or website integration. |
| "Open YouTube Music" | Opens YouTube Music in the configured browser. |
| "Close the current application" | Attempts to close the appropriate application safely where supported. |

Application names and available operations differ by platform. JARVIS should not claim that an application opened or closed unless the operation was verified.

### Files and folders

| Example command | What it does |
|---|---|
| "Find my Roblox folder" | Searches supported file locations for the requested folder. |
| "Open my Downloads folder" | Opens the user's Downloads folder where supported. |
| "Find my project folder" | Searches for a matching project folder using available file-search functionality. |
| "Open the JARVIS project" | Attempts to locate and open the appropriate project folder. |

File access depends on operating-system permissions and the configured search locations. JARVIS should not open unrelated files simply because their names are similar.

### Browser and music controls

| Example command | What it does |
|---|---|
| "List my browser tabs" | Lists tabs when the supported browser integration is connected. |
| "Close the current tab" | Closes the active tab through the supported browser-control integration. |
| "Open YouTube Music" | Opens the configured music website. |
| "Play Magnetic" | Attempts to find and play the requested track when supported music-search and playback controls are available. |
| "Pause the music" | Pauses playback through the supported media integration. |
| "Resume the music" | Resumes playback when the active media player supports it. |
| "Skip to the next song" | Advances playback where supported. |

Browser and media commands require the corresponding integrations to be enabled and connected.

### Screen and camera awareness

| Example command | What it does |
|---|---|
| "What's on my screen?" | Requests analysis of a supported screen capture. |
| "Explain this window." | Requests an explanation of the visible content where screen analysis is available. |
| "What am I holding?" | Requests camera-based visual analysis when the camera integration is available and permitted. |
| "Describe this image." | Requests image analysis when the relevant image input is supported. |

Camera and screen access may require explicit operating-system permissions. These commands should report when access is unavailable rather than inventing results.

### System monitoring

| Example command | What it does |
|---|---|
| "How much CPU am I using?" | Requests the current CPU usage where monitoring is supported. |
| "Show my memory usage." | Requests current memory statistics. |
| "How is my system performing?" | Requests a summary of available system-monitor information. |

The reported values depend on the system-monitoring implementation available on the current platform.

### Assistant modes

| Example command | What it does |
|---|---|
| "Enter study mode" | Enables Study Mode where implemented. |
| "Enter game mode" | Enables Game Mode where implemented. |
| "Enter music mode" | Enables Music Mode where implemented. |
| "Exit study mode" | Returns from the active mode where supported. |

Mode behavior depends on the features included in the installed version.

### Reminders and alarms

| Example command | What it does |
|---|---|
| "Remind me to study at 7 PM." | Creates a reminder if the reminder system is enabled. |
| "What reminders do I have?" | Lists saved reminders where supported. |
| "Cancel that reminder." | Attempts to remove the relevant reminder if the application can identify it. |
| "Set an alarm for tomorrow morning." | Requests an alarm, if alarms and the required scheduling features are implemented. |

Confirm the interpreted date and time when necessary. Time-based features may require the application to remain active or have a supported background service.

### AI and learning

| Example command | What it does |
|---|---|
| "Explain this math question step by step." | Requests a step-by-step explanation. |
| "Help me understand this science topic." | Requests a learning-focused explanation. |
| "Summarize this text." | Requests a summary of supplied content. |
| "Compare these two options." | Requests a contextual comparison. |
| "Give me another example." | Requests an additional example related to the current topic. |

The quality and availability of AI responses depend on the selected model, provider, configuration, and network access where applicable.

**Important:** The examples above are a command guide, not a guarantee that every command is implemented in every release. Check your installed version's supported features and settings.

## Main Goals

- Understand natural voice commands and everyday conversation.
- Support wake-word activation where available.
- Provide Push-to-Talk as a direct speech-to-text entry method.
- Respond using a configured AI voice.
- Support local AI for general questions and conversations where configured.
- Offer optional external AI APIs.
- Open supported applications, websites, files, and folders.
- Control supported browser tabs and media players.
- Play and control music through supported integrations.
- Monitor CPU and memory usage.
- Support camera and screen recognition where possible.
- Provide reminders, alarms, and calendar-related functions where implemented.
- Support Music, Game, and Study modes where available.
- Maintain the futuristic animated HUD.
- Make configuration accessible through the interface.
- Improve cross-platform compatibility without unnecessarily removing working features.

## Development Journey

1. **Initial inspiration** — The idea came from the JARVIS assistant in Iron Man.
2. **Feature planning** — Planned voice commands, computer controls, AI capabilities, and the interface.
3. **Core application** — Developed the main assistant interface and animated HUD.
4. **Computer integration** — Added supported browser control, application launching, media playback, and system monitoring.
5. **Voice improvements** — Improved speech recognition, noise filtering, and wake-word detection.
6. **Visual awareness** — Explored camera input and screen recognition.
7. **Assistant modes** — Developed Music, Game, and Study modes alongside conversational follow-ups.
8. **Reliability improvements** — Worked on repeated speech, incorrect command routing, and voice feedback loops.
9. **Natural conversation** — Continued improving contextual responses, memory, and conversational understanding.
10. **Push-to-Talk** — Added a manual speech-capture workflow intended to enter the same conversation pipeline as live voice.
11. **Cross-platform development** — Worked toward making JARVIS Share accessible on Windows, macOS, and Arch Linux.
12. **Ongoing refinement** — Continued testing features, fixing bugs, and improving stability.

## Design Philosophy

- **Hands-free:** Voice is a primary way to interact with JARVIS where supported.
- **Accessible:** Users should be able to configure the application through its interface.
- **Natural:** Understand different ways of expressing the same request.
- **Local-first:** Use local processing where practical.
- **Optional:** Allow users to enable supported external services and integrations as needed.
- **Responsive:** Provide clear feedback when commands are processed.
- **Modular:** Improve features without unnecessarily breaking other components.
- **Consistent:** Preserve the existing interface and working features during updates.
- **Cross-platform:** Implement platform-appropriate behavior rather than assuming Windows, macOS, and Linux are identical.

## Project Status

JARVIS is an ongoing development project. Features are being built, tested, and refined. A feature being planned or explored does not necessarily mean it is fully implemented or reliable.

Platform support may vary by release. Some functions may depend on optional software, service credentials, hardware, permissions, or specific browser integrations.

Check the release notes and the supported-feature information for the version you download. Features should be marked implemented and verified only after appropriate testing.

## Safety and Privacy

JARVIS may interact with local files, applications, a microphone, a camera, and external AI or voice services.

- Keep API keys and credentials out of source control.
- Do not distribute private `.env` files, local configuration, conversation logs, or browser profiles.
- Protect personal conversation logs and private settings.
- Review permissions before enabling microphone, camera, screen-analysis, or computer-control features.
- Understand which services process data locally and which send information externally.
- Configure your own API credentials through the supported setup interface where available.
- Review external provider usage limits, costs, and privacy policies.
- Do not collect or transmit browser cookies, authentication tokens, or other credentials without authorization.
- Use platform-appropriate credential storage and application permissions.

## Development Guidelines

- Back up the working project before significant changes.
- Preserve the existing interface and working features.
- Make focused changes instead of rewriting unrelated components.
- Test affected features after changes.
- Keep secrets, caches, generated files, private logs, and unnecessary large assets out of Git.
- Document platform requirements and feature availability.
- Verify installation packages and release artifacts before distribution.
- Do not claim a feature works on a platform unless it has been tested there.

## Credits

**Created and developed by Tharn.**

JARVIS is a personal desktop-assistant project inspired by the idea of bringing a cinematic AI assistant into practical everyday use.

## Vision

The long-term goal is to create a capable, personalized desktop assistant that combines voice interaction, AI reasoning, computer automation, system awareness, and a cinematic interface in one application.

**JARVIS is more than a basic voice-command script — it is an ongoing attempt to build a practical desktop AI assistant inspired by the idea of JARVIS.**

---

*Built and developed by Tharn.*
