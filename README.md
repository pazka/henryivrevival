# Henry IV Revival

Quick fun spiritism seance with King Henry IV for my friend.

It uses OpenAI gpt0 and TTS to generate a text and read it out loud.

It uses the native chrome SpeechToText API to listen to the user's voice and generate a response.

## Usage

```bash
docker run -it --rm -p 3000:3000  pazka/henryivrevival:latest
```

Then open your browser at <http://localhost:3000>

Or use docker compose :

```yaml
version: '3.3'
services:
    henryivrevival:
        restart: always
        image: pazka/henryivrevival:latest
        environment:
            - OPENAI_API_KEY=<your_openai_api_key>
        ports:
            - "3000:3000"
```

WIth docker compose, you can use the same `.env` file as the one used for the development. with your `OPENAI_API_KEY` in it.

```text
OPENAI_API_KEY=<your_openai_api_key>
```
