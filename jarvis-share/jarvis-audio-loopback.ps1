# JARVIS system-audio capture (WASAPI loopback) + real-time FFT frame stream.
#
# Prints one compact frame per line on stdout:
#   READY <sampleRate> <channels> <fftSize> <fps>
#   F <level> <bass> <lowMid> <mid> <high> <peakDb> <rmsDb>
#   ERR <message>
#
# This captures the Windows output mix (WASAPI loopback on the default render
# endpoint), so it hears whatever is playing: Chrome, Edge, Spotify, games,
# media players. It does not use the microphone and does not depend on any
# browser automation. The FFT is the real measured spectrum.
#
# Used by server.js (spawned as a child process); frames are read from stdout.
param(
  [int]$Fps = 30,
  [double]$Seconds = 0,          # 0 = run until killed
  [int]$FftSize = 1024,
  [switch]$SelfTest              # print one summary line per second, then exit
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class JarvisLoopback
{
    private const int AUDCLNT_SHAREMODE_SHARED = 0;
    private const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const int WAVE_FORMAT_IEEE_FLOAT = 3;
    private const int WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
    private const int KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = 3;
    private const int DEVICE_STATE_ACTIVE = 0x00000001;
    private const int eRender = 0;
    private const int eConsole = 0;

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
        int OpenPropertyStore(int access, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr format, IntPtr audioSessionGuid);
        int GetBufferSize(out int frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out int padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid id, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out int frames, out int flags, out long devicePosition, out long qpcPosition);
        int ReleaseBuffer(int frames);
        int GetNextPacketSize(out int frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    public static string LastError = "";

    private static float[] window;
    private static float[] re;
    private static float[] im;
    private static float[] cosTable;
    private static float[] sinTable;

    private static void PrepareFft(int n)
    {
        window = new float[n];
        for (int i = 0; i < n; i++) window[i] = (float)(0.5 - 0.5 * Math.Cos(2.0 * Math.PI * i / (n - 1)));
        re = new float[n];
        im = new float[n];
        cosTable = new float[n / 2];
        sinTable = new float[n / 2];
        for (int i = 0; i < n / 2; i++)
        {
            double angle = -2.0 * Math.PI * i / n;
            cosTable[i] = (float)Math.Cos(angle);
            sinTable[i] = (float)Math.Sin(angle);
        }
    }

    // In-place iterative radix-2 FFT.
    private static void Fft(int n)
    {
        int j = 0;
        for (int i = 0; i < n; i++)
        {
            if (i < j)
            {
                float t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
            int m = n >> 1;
            while (m >= 1 && j >= m) { j -= m; m >>= 1; }
            j += m;
        }
        for (int size = 2; size <= n; size <<= 1)
        {
            int half = size >> 1;
            int step = n / size;
            for (int start = 0; start < n; start += size)
            {
                for (int k = 0; k < half; k++)
                {
                    int idx = k * step;
                    float wr = cosTable[idx], wi = sinTable[idx];
                    int a = start + k, b = a + half;
                    float tr = re[b] * wr - im[b] * wi;
                    float ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                }
            }
        }
    }

    // Band energy in dB, normalized 0..1 across a -100..-20 dB window; the same
    // scale the front-end uses, so bands and bars stay comparable.
    private static double Band(float[] magnitudeDb, double binHz, double lowHz, double highHz, int bins)
    {
        int from = Math.Max(1, (int)Math.Floor(lowHz / binHz));
        int to = Math.Min(bins - 1, (int)Math.Ceiling(highHz / binHz));
        if (to < from) return 0.0;
        double power = 0.0;
        for (int i = from; i <= to; i++) power += Math.Pow(10.0, magnitudeDb[i] / 10.0);
        double bandDb = 10.0 * Math.Log10(power / (to - from + 1));
        double value = (bandDb + 100.0) / 80.0;
        return value < 0 ? 0 : value > 1 ? 1 : value;
    }

    // Builds one frame line from the pending ring: a real FFT of the newest
    // window, the band energies and the 12 log-spaced spectrum buckets. Slides
    // the ring by half a window so updates stay dense, and returns the exact
    // line to print. Every value here is measured audio; nothing is invented.
    private static string NextFrame(float[] pending, ref int pendingCount, int fftSize, int sampleRate, bool selfTest)
    {
        double sumSquares = 0;
        for (int i = 0; i < fftSize; i++)
        {
            float sample = i < pendingCount ? pending[i] : 0f;
            sumSquares += sample * sample;
            re[i] = sample * window[i];
            im[i] = 0f;
        }
        Fft(fftSize);
        int bins = fftSize / 2;
        float[] magnitudeDb = new float[bins];
        double peak = 0.0;
        for (int k = 0; k < bins; k++)
        {
            double magnitude = Math.Sqrt(re[k] * (double)re[k] + im[k] * (double)im[k]) / (fftSize / 4.0);
            double db = 20.0 * Math.Log10(Math.Max(1e-12, magnitude));
            if (db > peak) peak = db;
            magnitudeDb[k] = (float)db;
        }
        double rms = Math.Sqrt(sumSquares / fftSize);
        double rmsDb = 20.0 * Math.Log10(Math.Max(1e-12, rms));
        double level = rms / 0.7; if (level > 1) level = 1;
        double binHz = (double)sampleRate / fftSize;
        double bass = Band(magnitudeDb, binHz, 20, 160, bins);
        double lowMid = Band(magnitudeDb, binHz, 160, 500, bins);
        double mid = Band(magnitudeDb, binHz, 500, 2000, bins);
        double high = Band(magnitudeDb, binHz, 2000, 12000, bins);
        // Twelve log-spaced buckets for the wave bars.
        string barText = "";
        double lowHz = 40, highHz = Math.Min(12000, binHz * (bins - 1));
        double ratio = Math.Pow(highHz / lowHz, 1.0 / 11.0);
        for (int b = 0; b < 12; b++)
        {
            double fromHz = lowHz * Math.Pow(ratio, b);
            double toHz = b == 11 ? highHz : lowHz * Math.Pow(ratio, b + 1);
            float bucketValue = (float)Band(magnitudeDb, binHz, fromHz, toHz, bins);
            barText += " " + bucketValue.ToString("F3");
        }
        string line;
        if (selfTest)
        {
            line = "TEST level=" + level.ToString("F3") + " bass=" + bass.ToString("F3") + " lowMid=" + lowMid.ToString("F3") + " mid=" + mid.ToString("F3") + " high=" + high.ToString("F3") + " peakDb=" + peak.ToString("F1");
        }
        else
        {
            line = "F " + level.ToString("F4") + " " + bass.ToString("F4") + " " + lowMid.ToString("F4") + " " + mid.ToString("F4") + " " + high.ToString("F4") + " " + peak.ToString("F1") + " " + rmsDb.ToString("F1") + barText;
        }
        int drop = Math.Min(pendingCount, fftSize / 2);
        if (drop > 0)
        {
            Array.Copy(pending, drop, pending, 0, pendingCount - drop);
            pendingCount -= drop;
        }
        return line;
    }

    public static void Run(int fps, double seconds, int fftSize, bool selfTest)
    {
        PrepareFft(fftSize);
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        int hr = enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device);
        if (hr != 0) throw new Exception("GetDefaultAudioEndpoint 0x" + hr.ToString("X8"));
        Guid iid = typeof(IAudioClient).GUID;
        object clientObject;
        hr = device.Activate(ref iid, 1 /* CLSCTX_INPROC_SERVER */, IntPtr.Zero, out clientObject);
        if (hr != 0) throw new Exception("Activate IAudioClient 0x" + hr.ToString("X8"));
        var audioClient = (IAudioClient)clientObject;

        IntPtr formatPtr;
        hr = audioClient.GetMixFormat(out formatPtr);
        if (hr != 0) throw new Exception("GetMixFormat 0x" + hr.ToString("X8"));
        var format = (WAVEFORMATEX)Marshal.PtrToStructure(formatPtr, typeof(WAVEFORMATEX));
        int channels = format.nChannels;
        int sampleRate = (int)format.nSamplesPerSec;
        int bits = format.wBitsPerSample;
        bool isFloat = format.wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
        if (format.wFormatTag == WAVE_FORMAT_EXTENSIBLE && bits == 32) isFloat = true; // shared mix is float

        // 200 ms shared buffer, polled every 10 ms: simple and robust, no
        // event-callback plumbing needed for a visualizer.
        long bufferDuration = 2000000;
        hr = audioClient.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, bufferDuration, 0, formatPtr, IntPtr.Zero);
        if (hr != 0) throw new Exception("Initialize loopback 0x" + hr.ToString("X8"));

        Guid captureIid = typeof(IAudioCaptureClient).GUID;
        object captureObject;
        hr = audioClient.GetService(ref captureIid, out captureObject);
        if (hr != 0) throw new Exception("GetService IAudioCaptureClient 0x" + hr.ToString("X8"));
        var capture = (IAudioCaptureClient)captureObject;

        audioClient.Start();
        Console.Out.WriteLine("READY " + sampleRate + " " + channels + " " + fftSize + " " + fps);
        Console.Out.Flush();

        int frameMs = Math.Max(10, 1000 / Math.Max(1, fps));
        // Ring for incoming samples. A 200 ms stereo packet at 48 kHz is ~9600
        // samples, so the buffer must comfortably exceed one packet.
        float[] pending = new float[fftSize * 32];
        int pendingCount = 0;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        long nextEmit = 0;
        var started = DateTime.UtcNow;
        int packetSize;
        byte[] scratch = new byte[8192];

        while (true)
        {
            if (seconds > 0 && (DateTime.UtcNow - started).TotalSeconds >= seconds) break;
            hr = capture.GetNextPacketSize(out packetSize);
            if (hr != 0) throw new Exception("GetNextPacketSize 0x" + hr.ToString("X8"));
            if (packetSize == 0)
            {
                // WASAPI loopback delivers NO packets while nothing is playing.
                // The frame stream must not depend on packets, so emit on the
                // same schedule here: otherwise the stream stops the moment the
                // sound does, the orb freezes on its last frame, and it never
                // settles, hides, or notices media starting again. That stall
                // was the Media Orb's real failure.
                System.Threading.Thread.Sleep(4);
                if (pendingCount == 0 && clock.ElapsedMilliseconds >= nextEmit)
                {
                    nextEmit = clock.ElapsedMilliseconds + frameMs;
                    Console.Out.WriteLine(NextFrame(pending, ref pendingCount, fftSize, sampleRate, selfTest));
                    Console.Out.Flush();
                }
            }
            else
            {
                IntPtr data;
                int frames, flags;
                long devicePosition, qpcPosition;
                hr = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                if (hr != 0) throw new Exception("GetBuffer 0x" + hr.ToString("X8"));
                int sampleCount = frames * channels;
                int bytesFloat = sampleCount * 4;
                if (!isFloat) bytesFloat = sampleCount * (bits / 8);
                if (scratch.Length < bytesFloat) scratch = new byte[bytesFloat];
                if (frames > 0) Marshal.Copy(data, scratch, 0, bytesFloat);
                capture.ReleaseBuffer(frames);

                // Silent packets carry undefined data: treat them as zeros so the
                // timeline stays accurate instead of skipping audio time.
                bool silentPacket = (flags & 0x2) != 0;
                for (int f = 0; f < frames; f++)
                {
                    float value = 0f;
                    if (!silentPacket)
                    {
                        float sum = 0;
                        int baseIndex = f * channels;
                        if (isFloat)
                        {
                            for (int c = 0; c < channels; c++)
                            {
                                int offset = (baseIndex + c) * 4;
                                sum += BitConverter.ToSingle(scratch, offset);
                            }
                        }
                        else if (bits == 16)
                        {
                            for (int c = 0; c < channels; c++)
                            {
                                int offset = (baseIndex + c) * 2;
                                sum += BitConverter.ToInt16(scratch, offset) / 32768f;
                            }
                        }
                        value = sum / channels;
                    }
                    if (pendingCount < pending.Length) pending[pendingCount++] = value;
                    else
                    {
                        // Never drop the whole window: discard the oldest half.
                        int half = pending.Length / 2;
                        Array.Copy(pending, half, pending, 0, half);
                        pendingCount = half;
                        pending[pendingCount++] = value;
                    }
                }

                // Emit every scheduled frame, including silence-flagged packets.
                while (clock.ElapsedMilliseconds >= nextEmit)
                {
                    nextEmit = clock.ElapsedMilliseconds + frameMs;
                    Console.Out.WriteLine(NextFrame(pending, ref pendingCount, fftSize, sampleRate, selfTest));
                    Console.Out.Flush();
                    if (pendingCount == 0) break;
                }
            }
        }

        try { audioClient.Stop(); } catch { }
        Console.Out.WriteLine("STOPPED");
        Console.Out.Flush();
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
  [JarvisLoopback]::Run($Fps, $Seconds, $FftSize, [bool]$SelfTest)
}
catch {
  $message = $null
  if ($_.Exception.InnerException) { $message = $_.Exception.InnerException.Message }
  if (-not $message) { $message = $_.Exception.Message }
  [Console]::Out.WriteLine("ERR $message")
  [Console]::Out.Flush()
  exit 1
}
