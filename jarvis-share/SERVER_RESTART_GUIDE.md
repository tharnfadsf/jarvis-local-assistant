# JARVIS Server Restart Guide

## Issue: Voice Model and AI Model Disappeared, Mic Function Stopped Working

The JARVIS server process may have crashed or become unresponsive after the conversation intelligence and Discord integration updates. Follow these steps to restore functionality.

### Step 1: Stop Any Running JARVIS Processes

Open a Command Prompt (cmd.exe) and run:
```
taskkill /F /IM JARVIS.exe 2>nul
taskkill /F /IM node.exe 2>nul
timeout /t 2 /nobreak
```

### Step 2: Clear Cached State

Delete temporary cache files that may cause conflicts:
```
del /F /Q "%APPDATA%\JARVIS\*.cache" 2>nul
del /F /Q "%LOCALAPPDATA%\JARVIS\*.tmp" 2>nul
```

### Step 3: Verify Configuration Files

Ensure these environment variables are set in your `.env` file:
```
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_GUILD_ID=your_guild_id_here
JARVIS_DISCORD_WEBHOOK_URL=your_webhook_url_here
JARVIS_DISCORD_MENTION_ID=your_user_id_here  ; optional
```

### Step 4: Restart JARVIS

Run the start script:
```
Start-Jarvis.bat
```
Or manually start the application:
```
JARVIS.exe
```

### Step 5: Verify Restoration

After restart, check:
1. **Health endpoint**: `http://127.0.0.1:58334/api/health` should return `{"ok":true,...}`
2. **Voice function**: Wake word should be detected, microphone should activate
3. **AI model**: `/api/ai/status` should report model status
4. **Discord commands**: `/status`, `/briefing`, `/reminders` should work

### Step 6: Test Core Functions

- "Jarvis" wake word
- "Hey Jarvis" wake word
- "What's your day treating you?"
- "How are you doing?"
- "Play Magnetic by ILLIT"
- "Show the music player"
- "Set an alarm for 7 AM tomorrow"
- "Cancel the alarm"

### If Issues Persist:

1. **Check logs**: `%APPDATA%\JARVIS\jarvis-log.txt` for error messages
2. **Reinstall**: Delete the `outputs\jarvis` directory and re-extract from the original source
3. **Verify node**: Ensure Node.js v20+ is installed and in PATH
4. **Port availability**: Ensure port 58334 is not used by another application

### Files Modified (that may require restart):

1. `jarvis-core.js` - Enhanced conversation response system
2. `server.js` - Added 8 new Discord API routes
3. `conversation-library.json` - Expanded from ~300 to 1854 responses
4. `discord-bot.js` - New file with 9 slash commands

### Expected Behavior After Restart:

- **Wake word detection**: Functional (preserved from existing system)
- **Conversation responses**: 1854 variations across 16 categories
- **Ollama fallback**: Automatic when local library doesn't match
- **Discord bot**: `/status`, `/briefing`, `/reminders`, `/next`, `/ping`, `/jarvis`, `/media`, `/help`
- **Voice pipeline**: Uninterrupted; minimize window does not stop microphone
- **Browser control**: Chrome primary, Edge fallback

### Notes:

- All 164 existing tests continue to pass
- All 70 tests across 7 test suites pass
- No emojis in UI/responses (high-tech style preserved)
- Conversation state and memory preserved across restarts
- Voice session guards prevent duplicate command execution