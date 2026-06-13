from openai import OpenAI
from dotenv import load_dotenv
from pathlib import Path
import os

env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)

github_token = os.getenv("GITHUB_TOKEN")

print("GITHUB TOKEN LOADED:", github_token[:10] + "..." if github_token else "NOT FOUND")

client = OpenAI(
    base_url="https://models.inference.ai.azure.com",
    api_key=github_token,
)

def ask_llm(prompt: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "user", "content": prompt}
        ],
        temperature=0.3
    )
    return response.choices[0].message.content