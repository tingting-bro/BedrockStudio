"""Launch the editor with the current system Python interpreter."""

import os
import sys
from multiprocessing import freeze_support

# Windows GUI workers can have no standard streams. Libraries imported during
# spawn still expect writable streams even when the application has no console.
if __name__ != "__main__":
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if worker_log := os.environ.get("BEDROCK_EDITOR_WORKER_LOG"):
        sys.stderr = open(worker_log, "a", encoding="utf-8")
    elif sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

if __name__ == "__main__":
    freeze_support()
    from bedrock_editor.desktop import main

    main()
