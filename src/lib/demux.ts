import {
  createFile,
  DataStream,
  type ISOFile,
  type MP4BoxBuffer,
  type MultiBufferStream,
  type Movie,
  type Sample,
  type Track,
} from 'mp4box';

export interface VideoTrackInfo {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  frameCount: number;
  /** avcC/hvcC codec-specific config, as required by VideoDecoderConfig.description. */
  description: Uint8Array;
}

export interface DemuxResult {
  track: VideoTrackInfo;
  chunks: EncodedVideoChunk[];
}

interface ConfigBox {
  write(stream: MultiBufferStream): void;
}

function readTrackDescription(isoFile: ISOFile, track: Track): Uint8Array {
  const trak = isoFile.getTrackById(track.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as {
    avcC?: ConfigBox;
    hvcC?: ConfigBox;
  };
  const box = entry.avcC ?? entry.hvcC;
  if (!box) {
    throw new Error(
      `Unsupported codec on track ${track.id} — only H.264 and H.265 video are supported. Try re-encoding with ffmpeg/HandBrake to H.264.`,
    );
  }

  // avcC/hvcC's write() signature is typed for MultiBufferStream but only
  // calls DataStream's read/write primitives, which DataStream implements directly.
  const stream = new DataStream();
  box.write(stream as unknown as MultiBufferStream);
  const length = stream.getPosition() - 8; // strip the 8-byte box header (size + fourcc)
  return new Uint8Array(stream.buffer, 8, length).slice();
}

/** Demux an MP4/MOV file into video track info and encoded chunks, ready for VideoDecoder. */
export function demux(file: File): Promise<DemuxResult> {
  return new Promise((resolve, reject) => {
    const isoFile = createFile();
    const chunks: EncodedVideoChunk[] = [];

    isoFile.onError = (module, message) => reject(new Error(`mp4box ${module}: ${message}`));

    isoFile.onReady = (info: Movie) => {
      const track = info.videoTracks[0];
      if (!track || !track.video) {
        reject(new Error('No video track found in file'));
        return;
      }

      let description: Uint8Array;
      try {
        description = readTrackDescription(isoFile, track);
      } catch (err) {
        reject(err);
        return;
      }

      isoFile.onSamples = (_id: number, _user: unknown, samples: Sample[]) => {
        for (const sample of samples) {
          chunks.push(
            new EncodedVideoChunk({
              type: sample.is_sync ? 'key' : 'delta',
              timestamp: (sample.cts / sample.timescale) * 1_000_000,
              duration: (sample.duration / sample.timescale) * 1_000_000,
              data: sample.data!,
            }),
          );
        }
      };

      isoFile.setExtractionOptions(track.id, undefined, { nbSamples: Infinity });
      isoFile.start(); // synchronously drains all samples via onSamples above

      resolve({
        track: {
          codec: track.codec,
          codedWidth: track.video.width,
          codedHeight: track.video.height,
          frameCount: track.nb_samples,
          description,
        },
        chunks,
      });
    };

    file.arrayBuffer().then((buffer) => {
      const mp4boxBuffer = buffer as MP4BoxBuffer;
      mp4boxBuffer.fileStart = 0;
      isoFile.appendBuffer(mp4boxBuffer);
    }, reject);
  });
}
