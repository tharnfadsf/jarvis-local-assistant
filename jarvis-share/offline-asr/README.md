# offline-asr — local speech bridge (placeholder)

This folder is intentionally empty in the share package.

Your live project keeps the real bridge here:
`offline-asr/models/ggml-base.en-q8_0.bin` (~82 MB) and the
`offline-asr/runtime/Release/` binaries (~13 MB). They were left out
so this folder stays small enough to send.

To make voice work on a new machine, copy those two folders from your
working J.A.R.V.I.S. install into this `offline-asr/` directory,
keeping the same layout:

    offline-asr/
      models/
        ggml-base.en-q8_0.bin
      runtime/
        Release/
          whisper-cli.exe
          whisper.dll
          ...

Do NOT commit the `.bin` / `.dll` / `.exe` files to GitHub.
The `.gitignore` in this share package already excludes them.
