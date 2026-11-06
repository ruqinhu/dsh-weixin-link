import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Speech-to-text for inbound voice messages.
 *
 * The model itself cannot hear audio (verified on this deployment: an `input_audio`
 * request is rejected with 422), so the transcript has to be produced here. The
 * bundled helper does silk → wav → faster-whisper, which is what the inherited Hermes
 * gateway settled on: local, offline, no API key, and the `base` model because the box
 * has ~1.9 GB of memory shared with the harness.
 */
export interface SttOptions {
  /**
   * Overrides the bundled helper. `{file}` is replaced with the audio path.
   *
   * Exists because the helper needs `python3` plus `faster_whisper` and `pilk`; a host
   * without them can point this at any command that prints a transcript.
   */
  command?: string
  timeoutMs?: number
  /** Interpreter for the bundled helper. Defaults to `python3`. */
  python?: string
}

export interface SilkArgs {
  silk: string
  wav: string
  rate: number
}

/**
 * Arguments for the silk→wav conversion step.
 *
 * 24 kHz is what the Hermes skill measured as the right rate for WeChat voice; a
 * different rate resamples the audio and costs accuracy on Mandarin.
 */
export function silkToWavArgs(silk: string, wav: string): SilkArgs {
  return { silk, wav, rate: 24_000 }
}

const DEFAULT_TIMEOUT_MS = 180_000

/** Bundled helper, resolved from the built `lib/ilink/voice.js` or `src/ilink/voice.ts`. */
const BUNDLED_SCRIPT = fileURLToPath(new URL('../../scripts/stt.py', import.meta.url))

/** POSIX single-quote escaping for the `{file}` substitution. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Resolve one invocation into an argv and whether a shell is needed.
 *
 * The default path never uses a shell: a filename is data, and passing it through a
 * shell is how a quote in a name becomes a bug. Only a caller-supplied `command`
 * template takes the shell, because that is the whole point of a template.
 */
export function sttCommandFor(file: string, options: SttOptions = {}): { argv: string[]; shell: boolean } {
  const template = options.command?.trim() ?? ''
  if (template !== '') {
    return { argv: [template.replaceAll('{file}', shellQuote(file))], shell: true }
  }
  return { argv: [options.python ?? 'python3', BUNDLED_SCRIPT, file], shell: false }
}

/**
 * Transcribe one audio file, or reject with a reason the caller can log.
 *
 * An empty transcript is an error, not success: a voice message that produced no text
 * must fall back to "audio saved here", which is actionable, instead of becoming an
 * empty user turn.
 */
export async function transcribeVoice(file: string, options: SttOptions = {}): Promise<string> {
  const { argv, shell } = sttCommandFor(file, options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`transcription timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`transcription failed to start: ${error.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = stdout.trim()
      if (code !== 0) {
        reject(new Error(`transcription exited ${String(code)}: ${stderr.trim().slice(0, 200)}`))
        return
      }
      if (text === '') {
        reject(new Error('transcription produced no text'))
        return
      }
      resolve(text)
    })
  })
}
