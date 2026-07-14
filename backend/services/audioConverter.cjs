// services/audioConverter.js
// ============================================================
// Low-overhead audio translation for G.711 mu-law <-> PCM16
// and sample-rate conversions (8kHz <-> 16kHz <-> 24kHz)
// ============================================================

const alawmulaw = require("alawmulaw");

/**
 * Decodes 8kHz G.711 mu-law (Twilio inbound) to 8kHz 16-bit linear PCM
 * @param {Buffer} mulawBuffer 
 * @returns {Buffer} pcmBuffer
 */
function mulawToPcm16(mulawBuffer) {
  const uint8Samples = new Uint8Array(mulawBuffer);
  const decoded16 = alawmulaw.mulaw.decode(uint8Samples);
  return Buffer.from(decoded16.buffer, decoded16.byteOffset, decoded16.byteLength);
}

/**
 * Encodes 8kHz 16-bit linear PCM to 8kHz G.711 mu-law (Twilio outbound)
 * @param {Buffer} pcmBuffer 
 * @returns {Buffer} mulawBuffer
 */
function pcm16ToMulaw(pcmBuffer) {
  const aligned = new Uint8Array(pcmBuffer.length);
  aligned.set(pcmBuffer);
  const int16Samples = new Int16Array(
    aligned.buffer, 
    aligned.byteOffset, 
    Math.floor(aligned.length / 2)
  );
  const encoded8 = alawmulaw.mulaw.encode(int16Samples);
  return Buffer.from(encoded8.buffer, encoded8.byteOffset, encoded8.byteLength);
}

/**
 * Upsamples 16-bit PCM from 8kHz to 16kHz (for Gemini input)
 * Duplicates each sample (Zero-Order Hold / Linear Interpolation)
 * @param {Buffer} pcm8k 
 * @returns {Buffer} pcm16k
 */
function upsample8To16(pcm8k) {
  const samples8k = pcm8k.length / 2;
  const pcm16k = Buffer.alloc(pcm8k.length * 2);
  for (let i = 0; i < samples8k; i++) {
    const sample = pcm8k.readInt16LE(i * 2);
    pcm16k.writeInt16LE(sample, i * 4);
    pcm16k.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm16k;
}

/**
 * Downsamples 16-bit PCM from 24kHz to 8kHz (for Twilio outbound)
 * Keeps 1 out of every 3 samples
 * @param {Buffer} pcm24k 
 * @returns {Buffer} pcm8k
 */
function downsample24To8(pcm24k) {
  const samples24k = pcm24k.length / 2;
  const samples8k = Math.floor(samples24k / 3);
  const pcm8k = Buffer.alloc(samples8k * 2);
  for (let i = 0; i < samples8k; i++) {
    const sample = pcm24k.readInt16LE(i * 6);
    pcm8k.writeInt16LE(sample, i * 2);
  }
  return pcm8k;
}

/**
 * Downsamples 16-bit PCM from 16kHz to 8kHz
 * Keeps 1 out of every 2 samples
 * @param {Buffer} pcm16k 
 * @returns {Buffer} pcm8k
 */
function downsample16To8(pcm16k) {
  const samples16k = pcm16k.length / 2;
  const samples8k = Math.floor(samples16k / 2);
  const pcm8k = Buffer.alloc(samples8k * 2);
  for (let i = 0; i < samples8k; i++) {
    const sample = pcm16k.readInt16LE(i * 4);
    pcm8k.writeInt16LE(sample, i * 2);
  }
  return pcm8k;
}

module.exports = {
  mulawToPcm16,
  pcm16ToMulaw,
  upsample8To16,
  downsample24To8,
  downsample16To8
};
