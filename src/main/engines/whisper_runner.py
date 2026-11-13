# -*- coding: utf-8 -*-
"""Transcreve um arquivo de áudio/vídeo com o faster-whisper.

Uso: python whisper_runner.py <arquivo>

Imprime o andamento em JSON, uma linha por evento, pro app acompanhar:
  {"event": "loading", "model": "large-v3", "device": "cuda"}
  {"event": "info", "language": "pt", "duration": 63.2}
  {"event": "segment", "start": 0.0, "end": 3.2, "text": "..."}
  {"event": "done"}  ou  {"event": "error", "message": "..."}
"""
import glob
import importlib.util
import json
import os
import sys

# Do melhor pro mais leve. Usamos o primeiro que já estiver baixado nesta
# máquina. Este script nunca baixa modelo por conta própria: o app só o chama
# quando já existe um modelo em cache (ver pythonModelCached em whisper.js).
MODELS = ["large-v3", "large-v3-turbo", "large-v2", "medium", "small"]

# Placa de vídeo primeiro (bem mais rápido); processador como último recurso.
# "int8_float16" ocupa cerca de metade da memória de vídeo do "float16" com a
# mesma qualidade na prática. Numa placa de 6 GB o "float16" do large-v3 não
# cabe junto com os outros programas e fica ~30x mais lento, por isso não é usado.
ATTEMPTS = [("cuda", "int8_float16"), ("cuda", "int8"), ("cpu", "int8")]


def emit(**event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def add_cuda_dlls():
    """O faster-whisper precisa das DLLs de CUDA (cuBLAS/cuDNN). No Windows elas
    costumam vir dentro do PyTorch ou dos pacotes nvidia-*; aqui avisamos ao
    sistema onde procurar, senão a GPU não é usada. Fora do Windows quem acha
    as bibliotecas é o próprio sistema (e os.add_dll_directory nem existe)."""
    if os.name != "nt":
        return
    folders = []
    spec = importlib.util.find_spec("torch")
    if spec and spec.origin:
        folders.append(os.path.join(os.path.dirname(spec.origin), "lib"))
    for base in sys.path:
        folders.extend(glob.glob(os.path.join(base, "nvidia", "*", "bin")))
    for folder in folders:
        if os.path.isdir(folder):
            try:
                os.add_dll_directory(folder)
            except OSError:
                pass
            os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")


def pick_model():
    from faster_whisper.utils import download_model

    for name in MODELS:
        try:
            return name, download_model(name, local_files_only=True)
        except Exception:
            continue
    raise RuntimeError("nenhum modelo do faster-whisper em cache nesta máquina")


def main():
    audio = sys.argv[1]
    add_cuda_dlls()
    from faster_whisper import WhisperModel

    try:
        name, path = pick_model()
    except Exception as error:
        emit(event="error", message=str(error)[:500])
        return 1
    last_error = None

    for device, compute_type in ATTEMPTS:
        try:
            emit(event="loading", model=name, device=device)
            model = WhisperModel(path, device=device, compute_type=compute_type)
            # vad_filter pula silêncio e música, o que evita texto inventado.
            segments, info = model.transcribe(audio, vad_filter=True, beam_size=5)
            emit(event="info", language=info.language, duration=info.duration)
            count = 0
            for segment in segments:
                text = segment.text.strip()
                if text:
                    count += 1
                    emit(event="segment", start=segment.start, end=segment.end, text=text)
            emit(event="done", segments=count, model=name, device=device)
            return 0
        except Exception as error:  # tenta a próxima configuração
            last_error = error
            emit(event="retry", device=device, message=str(error)[:300])

    emit(event="error", message=str(last_error)[:500])
    return 1


if __name__ == "__main__":
    sys.exit(main())
