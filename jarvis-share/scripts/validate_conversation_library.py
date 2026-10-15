"""Validate response counts, duplicate strings, and required conversation coverage."""
from collections import Counter
from pathlib import Path
import json
import sys

LIBRARY = Path(__file__).resolve().parents[1] / "conversation-library.json"

def main():
    data = json.loads(LIBRARY.read_text(encoding="utf-8"))
    categories = data.get("categories")
    if not isinstance(categories, list) or not categories:
        raise SystemExit("FAIL: categories are missing or malformed.")
    intents = [intent for category in categories for intent in category.get("intents", [])]
    responses = [response for intent in intents for response in intent.get("responses", [])]
    counts = Counter(responses)
    duplicates = {response: count for response, count in counts.items() if count > 1}
    required = {"greeting", "mood_positive", "mood_okay", "mood_negative", "school", "gaming", "music_chat", "movies", "thanks", "compliment", "apology", "confusion", "uncertain", "plans", "boredom", "goodbye", "short_yes", "short_no", "short_maybe", "filler", "topic_change", "app_open_success"}
    missing = sorted(required - {intent["id"] for intent in intents})
    compliment_count = len(next((intent["responses"] for intent in intents if intent["id"] == "compliment"), []))
    launch_count = len(next((intent["responses"] for intent in intents if intent["id"] == "app_open_success"), []))
    empty = [intent.get("id", "?") for intent in intents if not intent.get("responses")]
    errors = []
    if len(responses) < 1000: errors.append(f"only {len(responses)} response strings; minimum is 1,000")
    if duplicates: errors.append(f"{len(duplicates)} duplicate response strings found")
    if missing: errors.append(f"required intents missing: {', '.join(missing)}")
    if empty: errors.append(f"intents with no responses: {', '.join(empty)}")
    if compliment_count < 100: errors.append(f"only {compliment_count} compliment replies; minimum is 100")
    if launch_count < 100: errors.append(f"only {launch_count} app-opening replies; minimum is 100")
    if errors:
        print("FAIL: " + "; ".join(errors))
        return 1
    print(f"PASS: {len(set(responses))} unique responses; {len(categories)} categories; {len(intents)} intents; {compliment_count} compliment replies; {launch_count} app-launch replies.")
    print(f"Dataset: {LIBRARY}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
