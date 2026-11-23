# E.L.I. – Assistente Virtual Web

Versão web full-stack (Express + React + Vite) do assistente virtual **ELI**, combinando síntese de voz via **Gemini 3.8 TTS (`Charon`)**, pesquisa e diálogo adaptativo via **Gemini 4 (`gemini-4-hydrogen`)**, reconhecimento de voz em português brasileiro (`Web Speech API`), geolocalização inteligente, isolamento e persistência de sessões, modo **widget incorporável (`/?embed=1`)** e integração opcional com serviço auxiliar local no Windows.

## Funcionalidades Preservadas e Evoluídas

- **Boas-vindas Inteligentes e Reconhecimento de Nome**: Saudação conforme horário local do usuário, sem assumir nomes fixos, perguntando como chamar você apenas quando necessário e lembrando por sessão.
- **Geolocalização e Clima Real**: Identificação automática via navegador + geocodificação reversa ou estimativa via IP (com confirmação explícita antes de consultas climáticas), usando OpenWeatherMap (`OPENWEATHER_KEY`) ou fallback Open-Meteo em tempo real.
- **Interface E.L.I.**: Núcleo animado em `#0B3D2E` / `#07291F` com estados `standby`, `listening`, `processing`, `speaking` (`#00FF00`), `executing` e `error`.
- **Voz Calibrada (Gemini 3.8 TTS + Voice Design)**: Streaming PCM de baixa latência sobre a voz base `Charon` (com seleção de timbre e analisador de áudio de referência em `/api/eli/analyze-voice`) e fallback para voz do navegador.
- **Comandos Naturais por Voz e Texto**: Interpretação natural de variações (ex.: *"registre uma anotação ..."*, *"qual foi a última coisa que pedi?"*, *"você se lembra do que anotei?"*, *"resuma nossa conversa"*, *"exclua minha última anotação"*, *"edite minha última anotação para ..."*, *"baixe minhas anotações"*, *"abra a calculadora"*, *"abra o VS Code"*).
- **Respostas Adaptativas com IA**: Concisas em consultas rápidas ou detalhadas quando solicitado, utilizando contexto isolado da própria sessão (últimas 20 interações e notas).
- **Memória Contextual, Modo Privado e Anotações**: Isolados por sessão via token aleatório de 256 bits (`SHA-256` no servidor, cookie `HttpOnly` e `Authorization: Bearer` em memória para iframes `/?embed=1`).
- **Playlists Validadas & Calculadora Web**: Validação real de URLs (`http://`/`https://`), bloqueio de links placeholders/inválidos e calculadora web integrada (`CalculatorModal`).
- **Serviço Auxiliar Local Windows (`windows-helper/`)**: Serviço Python opcional e isolado em `127.0.0.1:48731` com pareamento via código temporário de 6 dígitos + token Bearer, validação estrita de `Origin`, confirmação explícita e lista fechada de 5 ações (`open_browser`, `open_calculator`, `open_word`, `open_excel`, `open_vscode`), sem `shell=True`.

## Persistência de Sessões

O módulo `src/server/storage.ts` seleciona automaticamente o provedor conforme as variáveis de ambiente:

1. **Upstash Redis REST** (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) — recomendado para Cloud Run stateless.
2. **Google Cloud Firestore REST** (`FIRESTORE_PROJECT_ID`) — usa o token de conta de serviço do Cloud Run (Metadata Server) ou `FIRESTORE_ACCESS_TOKEN`.
3. **Volume / Arquivo local** (`ELI_DATA_DIR`, padrão `./.eli-data/sessions.json`) — persistência atômica em disco local ou Cloud Run Volume Mount.

## Variáveis de Ambiente

Veja `.env.example`:
- `GEMINI_API_KEY`: Chave da API Gemini (usada exclusivamente no servidor).
- `OPENWEATHER_KEY`: Chave opcional do OpenWeatherMap.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`: Persistência opcional via Upstash Redis REST.
- `FIRESTORE_PROJECT_ID`: Persistência opcional via Cloud Firestore REST.
- `ELI_DATA_DIR`: Diretório opcional para persistência em arquivo/volume montado.

## Serviço Auxiliar Windows

Consulte `windows-helper/README.md` para instruções detalhadas de execução (`start_windows_helper.bat` ou `python eli_windows_helper.py`), pareamento na aba **Computador (Windows)** e uso em origens HTTPS (Private Network Access e `--allow-origin`).
