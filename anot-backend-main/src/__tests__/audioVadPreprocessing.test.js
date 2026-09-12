const { buildFfmpegPreprocessArgs } = require('../services/audioProcessingService')

describe('Enhanced Clinical Audio Preprocessing (VAD & Bandpass)', () => {
  test('builds enhanced speech bandpass filter and adaptive silence removal arguments with defaults', () => {
    const inputPath = '/tmp/raw_encounter.wav'
    const outputPath = '/tmp/processed_encounter.mp3'
    const settings = {
      ffmpeg_enabled: true,
      ffmpeg_preprocess_before_transcribe: true,
      ffmpeg_target_format: 'mp3',
      ffmpeg_compression: 7,
    }

    const { args, ext } = buildFfmpegPreprocessArgs(inputPath, outputPath, settings)

    expect(ext).toBe('mp3')
    expect(args).toContain('-i')
    expect(args).toContain(inputPath)
    expect(args).toContain('-af')

    const afIdx = args.indexOf('-af')
    const filterChain = args[afIdx + 1]

    // Vocal bandpass check
    expect(filterChain).toContain('highpass=f=200')
    expect(filterChain).toContain('lowpass=f=3500')

    // Adaptive silence removal check (default -42dB, 0.8s pause, 0.2s lead-in)
    expect(filterChain).toContain('silenceremove=')
    expect(filterChain).toContain('start_duration=0.2')
    expect(filterChain).toContain('start_threshold=-42dB')
    expect(filterChain).toContain('stop_duration=0.8')
    expect(filterChain).toContain('stop_threshold=-42dB')

    // Optimal Deepgram sample rate & mono channel
    expect(args).toContain('-ar')
    expect(args).toContain('16000')
    expect(args).toContain('-ac')
    expect(args).toContain('1')

    // Output path must be last argument
    expect(args[args.length - 1]).toBe(outputPath)
  })

  test('respects custom silence threshold and duration from clinic settings', () => {
    const inputPath = '/tmp/raw_exam.wav'
    const outputPath = '/tmp/processed_exam.mp3'
    const settings = {
      ffmpeg_enabled: true,
      ffmpeg_target_format: 'mp3',
      ffmpeg_silence_threshold: '-40dB',
      ffmpeg_silence_duration: '1.0',
    }

    const { args } = buildFfmpegPreprocessArgs(inputPath, outputPath, settings)
    const afIdx = args.indexOf('-af')
    const filterChain = args[afIdx + 1]

    expect(filterChain).toContain('start_threshold=-40dB')
    expect(filterChain).toContain('stop_threshold=-40dB')
    expect(filterChain).toContain('stop_duration=1.0')
  })

  test('supports lossless PCM wav and opus targets', () => {
    const wavArgs = buildFfmpegPreprocessArgs('/tmp/in.mp3', '/tmp/out.wav', { ffmpeg_target_format: 'wav' })
    expect(wavArgs.ext).toBe('wav')
    expect(wavArgs.args).toContain('pcm_s16le')

    const oggArgs = buildFfmpegPreprocessArgs('/tmp/in.mp3', '/tmp/out.ogg', { ffmpeg_target_format: 'ogg' })
    expect(oggArgs.ext).toBe('ogg')
    expect(oggArgs.args).toContain('libopus')
  })
})
