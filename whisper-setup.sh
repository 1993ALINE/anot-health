#!/bin/bash
set -e

echo "=========================================="
echo "Starting Whisper STT Installation"
echo "=========================================="

yum update -y
yum install -y python3 python3-pip python3-devel ffmpeg

pip3 install openai-whisper flask boto3 python-dotenv

echo "Downloading Whisper model..."
python3 << 'PYTHON'
import whisper
print("Loading Whisper model...")
model = whisper.load_model("base")
print("✅ Model loaded!")
PYTHON

mkdir -p /home/ec2-user/whisper-api

cat > /home/ec2-user/whisper-api/whisper_api.py << 'FLASK'
import whisper
from flask import Flask, request, jsonify
import os

app = Flask(__name__)
model = whisper.load_model("base")

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'healthy', 'service': 'whisper-stt', 'model': 'base'})

@app.route('/transcribe', methods=['POST'])
def transcribe():
    try:
        if 'audio_file' not in request.files:
            return jsonify({'error': 'No audio file'}), 400
        file = request.files['audio_file']
        filepath = f'/tmp/{file.filename}'
        file.save(filepath)
        result = model.transcribe(filepath, language='en', fp16=False)
        os.remove(filepath)
        return jsonify({'transcript': result['text']}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
FLASK

cat > /etc/systemd/system/whisper-api.service << 'SERVICE'
[Unit]
Description=Whisper STT API
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/whisper-api
ExecStart=/usr/local/bin/python3 /home/ec2-user/whisper-api/whisper_api.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable whisper-api
systemctl start whisper-api

echo "✅ Whisper installation complete!"