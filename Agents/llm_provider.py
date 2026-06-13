from groq import Groq
from dotenv import load_dotenv
from pathlib import Path
import os

env_path = Path(__file__).parent / ".env"
load_dotenv(env_path)

api_key = os.getenv("GROQ_API_KEY")

print("GROQ KEY LOADED:", api_key[:10] + "..." if api_key else "NOT FOUND")

client = Groq(
    api_key=api_key
)

def ask_llm(prompt: str) -> str:

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {
                "role": "user",
                "content": prompt
            }
        ],
        temperature=0.3
    )

    return response.choices[0].message.content