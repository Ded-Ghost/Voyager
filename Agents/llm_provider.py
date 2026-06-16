from openai import OpenAI
from dotenv import load_dotenv
from pathlib import Path
import os

# The .env lives in the PROJECT ROOT (one level above this Agents/ folder), not
# inside Agents/. Load the root .env first, then fall back to a normal search
# so the token is found whether the swarm is started from the root or elsewhere.
_root_env = Path(__file__).resolve().parent.parent / ".env"
if _root_env.exists():
    load_dotenv(_root_env)
else:
    load_dotenv()  # fall back to default discovery (cwd upward)

github_token = (os.getenv("GITHUB_TOKEN") or "").strip().strip('"').strip("'")

print("GITHUB TOKEN LOADED:", github_token[:10] + "..." if github_token else "NOT FOUND")
if not github_token:
    print(
        "[llm_provider] WARNING: GITHUB_TOKEN is empty. The GitHub Models (Copilot) "
        "endpoint will reject every request. Set GITHUB_TOKEN in the root .env file."
    )

# GitHub Models / Copilot inference endpoint, authenticated with a GitHub PAT (ghp_...).
client = OpenAI(
    base_url="https://models.inference.ai.azure.com",
    api_key=github_token or "MISSING_GITHUB_TOKEN",
)

def ask_llm(prompt: str) -> str:
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
        )
    except Exception as e:
        # Surface a clear, actionable error instead of a raw stack trace.
        raise RuntimeError(
            f"GitHub Models (Copilot) request failed: {e}. "
            f"Check that GITHUB_TOKEN in .env is a valid GitHub PAT with Models access."
        ) from e
    content = response.choices[0].message.content if response.choices else None
    return content or ""