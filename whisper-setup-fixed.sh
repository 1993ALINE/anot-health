#!/bin/bash
set -e

echo "=========================================="
echo "Starting Whisper STT Installation"
echo "=========================================="

# Update system
echo "Updating system..."
yum update -y

# Install dependencies (fixed for Amazon Linux 2023)
echo "Installing dependencies..."
yum install -y python3 python3-pip python3-devel
yum install -y libsndfile-devel

# FFmpeg from EPEL
echo "Installing FFmpeg..."
amazon-linux-extras install -y ffmpeg || yum install -y ffmpeg || echo "FFmpeg optional"

# Install Whisper and Flask
echo "Installing Whisper and Flask..."
pip3 install --upgrade pip
pip3 install openai-whisper flask boto3 python-dotenv

# Download Whisper model
echo "Downloading Whisper model..."
python3 << 'PYTHON'
import whisper
import sys
try:
    print("Loading Whisper 'base' model...")
    model = whisper.load_model("base")
    print("✅ Model loaded successfully!")
except Exception as e:
    print(f"❌ Error: {e}")
    sys.exit(1)
PYTHON

# Create Flask app
echo "Creating Flask application..."
mkdir -p /home/ec2-user/whisper-api

cat > /home/ec2-user/whisper-api/whisper_api.py << 'FLASK'
#!/usr/bin/env python3
import whisper
from flask import Flask, request, jsonify
import os
import sys

app = Flask(__name__)

print("Loading Whisper model...")
try:
    model = whisper.load_model("base")
    print("✅ Whisper model loaded!")
except Exception as e:
    print(f"❌ Failed to load Whisper: {e}")
    sys.exit(1)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'healthy', 'service': 'whisper-stt', 'model': 'base'})

@app.route('/transcribe', methods=['POST'])
def transcribe():
    try:
        if 'audio_file' not in request.files:
            return jsonify({'error': 'No audio file provided'}), 400
        
        file = request.files['audio_file']
        filepath = f'/tmp/{file.filename}'
        file.save(filepath)
        
        print(f"🎙️ Transcribing: {file.filename}")
        result = model.transcribe(filepath, language='en', fp16=False)
        transcript = result['text']
        
        os.remove(filepath)
        
        print(f"✅ Transcription complete")
        return jsonify({'transcript': transcript, 'visit_id': request.form.get('visit_id', 'unknown')}), 200
    except Exception as e:
        print(f"❌ Error: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("Starting Flask server on 0.0.0.0:5000")
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)
FLASK

# Create systemd service
echo "Creating systemd service..."
cat > /etc/systemd/system/whisper-api.service << 'SERVICE'
[Unit]
Description=Whisper STT API Service
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/whisper-api
ExecStart=/usr/bin/python3 /home/ec2-user/whisper-api/whisper_api.py
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="PATH=/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=multi-user.target
SERVICE

# Start the service
echo "Starting Whisper API service..."
systemctl daemon-reload
systemctl enable whisper-api
systemctl start whisper-api

echo "=========================================="
echo "✅ Whisper Installation Complete!"
echo "=========================================="
echo "Service: whisper-api"
echo "Port: 5000"
echo "Status: systemctl status whisper-api"
echo "Test: curl http://localhost:5000/health"