import { useCallback, useEffect, useRef, useState } from "react"

// The Web Speech API is not in TypeScript's DOM lib; this is the slice we use.
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } }
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> }
type Recognition = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: RecognitionEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * Push-to-talk dictation: `start` listens until the speaker pauses, shows the
 * words as they come (`interim`), then hands the final sentence to `onFinal`.
 */
export function useDictation(onFinal: (text: string) => void) {
  const [supported] = useState(() => !!recognitionCtor())
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState("")
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<Recognition | null>(null)
  const finalRef = useRef("")
  const onFinalRef = useRef(onFinal)
  useEffect(() => {
    onFinalRef.current = onFinal
  }, [onFinal])
  useEffect(() => () => recRef.current?.abort(), [])

  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor || recRef.current) return
    const rec = new Ctor()
    rec.lang = navigator.language || "en-US"
    rec.interimResults = true
    rec.continuous = false
    finalRef.current = ""
    rec.onresult = (e) => {
      let live = ""
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalRef.current += r[0].transcript
        else live += r[0].transcript
      }
      setInterim((finalRef.current + live).trim())
    }
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setError("Microphone access was blocked.")
      else if (e.error !== "no-speech" && e.error !== "aborted") setError("Didn't catch that. Try again.")
    }
    rec.onend = () => {
      recRef.current = null
      setListening(false)
      setInterim("")
      const text = finalRef.current.trim()
      if (text) onFinalRef.current(text)
    }
    recRef.current = rec
    setError(null)
    setInterim("")
    setListening(true)
    stopSpeaking()
    rec.start()
  }, [])

  const stop = useCallback(() => recRef.current?.stop(), [])
  const cancel = useCallback(() => {
    finalRef.current = ""
    recRef.current?.abort()
  }, [])

  return { supported, listening, interim, error, start, stop, cancel }
}

export function canSpeak() {
  return typeof window !== "undefined" && "speechSynthesis" in window
}

export function speak(text: string, onEnd?: () => void) {
  if (!canSpeak() || !text.trim()) return
  const synth = window.speechSynthesis
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 1.04
  const lang = navigator.language || "en-US"
  const voice = synth.getVoices().find((v) => v.lang === lang && /natural|premium|enhanced|google/i.test(v.name)) ?? synth.getVoices().find((v) => v.lang === lang)
  if (voice) u.voice = voice
  u.onend = () => onEnd?.()
  u.onerror = () => onEnd?.()
  synth.speak(u)
}

export function stopSpeaking() {
  if (canSpeak()) window.speechSynthesis.cancel()
}
