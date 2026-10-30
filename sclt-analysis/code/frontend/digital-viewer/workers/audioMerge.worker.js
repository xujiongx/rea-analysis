/* eslint-disable no-restricted-globals */

const writeString = (view, offset, str) => {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
};

const base64ToArrayBuffer = (base64) => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
};

const fetchAudioArrayBuffer = async (url) => {
  if (url.startsWith('data:')) {
    const content = url.split(',')[1] || '';
    return base64ToArrayBuffer(content);
  }
  const res = await fetch(url);
  return res.arrayBuffer();
};

const decodeUrlToChannel = async (url) => {
  const arrayBuffer = await fetchAudioArrayBuffer(url);
  const offlineCtx = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer.slice(0));
  return {
    samples: audioBuffer.getChannelData(0),
    sampleRate: audioBuffer.sampleRate || 44100,
  };
};

const mergeChannels = (segments) => {
  let totalLength = 0;
  for (const segment of segments) {
    totalLength += segment.length;
  }

  const merged = new Float32Array(totalLength);
  let cursor = 0;
  for (const segment of segments) {
    merged.set(segment, cursor);
    cursor += segment.length;
  }

  return merged;
};

const float32ToWavBuffer = (samples, sampleRate) => {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      offset,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }

  return arrayBuffer;
};

self.onmessage = async (event) => {
  const { type, payload } = event.data || {};

  if (type === 'FETCH_DECODE_MERGE_AUDIO') {
    try {
      const { requestId, urls } = payload || {};
      const decodedSegments = [];
      let sampleRate = 44100;
      for (const url of urls || []) {
        const decoded = await decodeUrlToChannel(url);
        sampleRate = decoded.sampleRate || sampleRate;
        decodedSegments.push(decoded.samples);
      }
      if (!decodedSegments.length) {
        throw new Error('no audio segments decoded');
      }
      const merged = mergeChannels(decodedSegments);
      const wavBuffer = float32ToWavBuffer(merged, sampleRate);
      self.postMessage(
        {
          type: 'MERGE_AUDIO_DONE',
          payload: {
            requestId,
            wavBuffer,
          },
        },
        [wavBuffer],
      );
    } catch (error) {
      self.postMessage({
        type: 'MERGE_AUDIO_ERROR',
        payload: {
          source: 'FETCH_DECODE_MERGE_AUDIO',
          message: error instanceof Error ? error.message : 'decode merge failed',
        },
      });
    }
    return;
  }

  if (type !== 'MERGE_AUDIO') {
    return;
  }

  try {
    const { requestId, sampleRate, segments } = payload || {};
    const merged = mergeChannels(
      (segments || []).map((segment) => new Float32Array(segment)),
    );
    const wavBuffer = float32ToWavBuffer(merged, sampleRate || 44100);
    self.postMessage(
      {
        type: 'MERGE_AUDIO_DONE',
        payload: {
          requestId,
          wavBuffer,
        },
      },
      [wavBuffer],
    );
  } catch (error) {
    self.postMessage({
      type: 'MERGE_AUDIO_ERROR',
      payload: {
        message: error instanceof Error ? error.message : 'merge failed',
      },
    });
  }
};
