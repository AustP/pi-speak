import Foundation
import AppKit
import AVFoundation
import Speech

final class WinstonListener {
    private let keyword = "winston"
    private let cancelPhrases = ["never mind", "nevermind"]
    private let keywordDebounceSeconds: TimeInterval = 1.2
    private let minimumRecordingSeconds: TimeInterval = 1.8
    private let postStopStartCooldownSeconds: TimeInterval = 2.0
    private let superwhisperAppName = "Superwhisper"

    private let duckOutputWhileRecording = true
    private let duckedOutputVolumePercent = 0

    private let clipboardPollIntervalSeconds: TimeInterval = 0.5
    private let clipboardTimeoutSeconds: TimeInterval = 90

    private let listenerRootDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    private var piInjectCommandPath: String {
        listenerRootDirectory.appendingPathComponent("scripts/pi-inject.sh").path
    }

    private var ttsControlSocketPath: String {
        URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pi-tts-control.sock").path
    }

    private let captureDirectory: URL
    private let audioEngine = AVAudioEngine()
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionTaskGeneration: UInt64 = 0
    private var pendingRecognitionRestartWorkItem: DispatchWorkItem?
    private var isShuttingDown = false
    private let audioStateLock = NSLock()

    private var sigintSource: DispatchSourceSignal?
    private var sigtermSource: DispatchSourceSignal?

    private var clipboardMonitorTimer: DispatchSourceTimer?
    private var waitingForTranscriptionClipboard = false
    private var pendingTranscriptionWavURL: URL?
    private var pendingFocusRestoreBundleID: String?
    private var clipboardBaselineChangeCount = 0
    private var clipboardMonitorDeadline: Date?
    private var clipboardSnapshotText: String?

    private var isRecording = false
    private var recordingStartedAt: Date?
    private var currentRecordingFile: AVAudioFile?
    private var currentRecordingURL: URL?

    private var outputWasDucked = false
    private var previousOutputVolume: Int?
    private var previousOutputMuted: Bool?

    private var handledKeywordSegmentIDs: Set<String> = []
    private var lastKeywordHandledAt = Date.distantPast
    private var ignoreStartKeywordsUntil = Date.distantPast

    init() {
        captureDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("captures", isDirectory: true)
    }

    func run() throws {
        try ensurePermissions()
        try ensureCaptureDirectory()

        guard let speechRecognizer, speechRecognizer.isAvailable else {
            throw NSError(domain: "WinstonListener", code: 1, userInfo: [NSLocalizedDescriptionKey: "Speech recognizer is not available"])
        }

        try setupAudioPipeline()
        startRecognitionTask(reason: "initial startup")
        setupSignalHandlers()

        print("Always-on listener started.")
        print("Start word: Winston")
        print("End word: Winston")
        print("Cancel phrase: Never mind")
        print("Capture directory: \(captureDirectory.path)")
        if duckOutputWhileRecording {
            print("Speaker behavior: duck to \(duckedOutputVolumePercent)% during recording, then restore")
        }

        RunLoop.main.run()
    }

    private func ensurePermissions() throws {
        let speechAllowed = DispatchSemaphore(value: 0)
        var speechStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined

        SFSpeechRecognizer.requestAuthorization { status in
            speechStatus = status
            speechAllowed.signal()
        }
        speechAllowed.wait()

        guard speechStatus == .authorized else {
            throw NSError(domain: "WinstonListener", code: 2, userInfo: [NSLocalizedDescriptionKey: "Speech recognition permission was denied"])
        }

        let micAllowed = DispatchSemaphore(value: 0)
        var micGranted = false

        AVCaptureDevice.requestAccess(for: .audio) { granted in
            micGranted = granted
            micAllowed.signal()
        }
        micAllowed.wait()

        guard micGranted else {
            throw NSError(domain: "WinstonListener", code: 3, userInfo: [NSLocalizedDescriptionKey: "Microphone permission was denied"])
        }
    }

    private func ensureCaptureDirectory() throws {
        try FileManager.default.createDirectory(at: captureDirectory, withIntermediateDirectories: true)
    }

    private func withAudioStateLock<T>(_ body: () -> T) -> T {
        audioStateLock.lock()
        defer { audioStateLock.unlock() }
        return body()
    }

    private func setupAudioPipeline() throws {
        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }

            let (request, shouldRecord, recordingFile) = self.withAudioStateLock {
                (self.recognitionRequest, self.isRecording, self.currentRecordingFile)
            }

            request?.append(buffer)

            if shouldRecord, let recordingFile {
                do {
                    try recordingFile.write(from: buffer)
                } catch {
                    print("[recording] failed to write audio: \(error.localizedDescription)")
                }
            }
        }

        audioEngine.prepare()
        try audioEngine.start()
    }

    private func startRecognitionTask(reason: String) {
        guard !isShuttingDown else { return }

        pendingRecognitionRestartWorkItem?.cancel()
        pendingRecognitionRestartWorkItem = nil

        recognitionTaskGeneration += 1
        let generation = recognitionTaskGeneration

        let previousTask = recognitionTask
        recognitionTask = nil
        previousTask?.cancel()

        let previousRequest = withAudioStateLock {
            let request = recognitionRequest
            recognitionRequest = nil
            return request
        }
        previousRequest?.endAudio()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if speechRecognizer?.supportsOnDeviceRecognition == true {
            request.requiresOnDeviceRecognition = true
        }
        withAudioStateLock {
            recognitionRequest = request
        }

        handledKeywordSegmentIDs.removeAll(keepingCapacity: true)
        print("[speech] started recognition task #\(generation) (\(reason))")

        recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            DispatchQueue.main.async {
                guard !self.isShuttingDown else { return }
                guard generation == self.recognitionTaskGeneration else { return }

                if let result {
                    self.handleRecognitionResult(result)

                    if result.isFinal {
                        self.scheduleRecognitionRestart(after: 0.1, reason: "final result")
                        return
                    }
                }

                if let error {
                    let message = error.localizedDescription.lowercased()
                    if message.contains("no speech detected") {
                        self.scheduleRecognitionRestart(after: 0.8, reason: "no speech detected")
                        return
                    }

                    print("[speech] recognition error: \(error.localizedDescription)")
                    self.scheduleRecognitionRestart(after: 0.3, reason: "error")
                }
            }
        }
    }

    private func scheduleRecognitionRestart(after delay: TimeInterval, reason: String) {
        guard !isShuttingDown else { return }

        pendingRecognitionRestartWorkItem?.cancel()

        let workItem = DispatchWorkItem { [weak self] in
            self?.startRecognitionTask(reason: reason)
        }

        pendingRecognitionRestartWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func handleRecognitionResult(_ result: SFSpeechRecognitionResult) {
        let currentlyRecording = withAudioStateLock { isRecording }

        if currentlyRecording {
            let fullText = result.bestTranscription.formattedString.lowercased()

            if containsCancelPhrase(in: fullText) {
                print("[speech] detected cancel phrase in transcription: \(fullText)")
                cancelRecording()
                return
            }

            if let lastSegment = result.bestTranscription.segments.last {
                let normalized = lastSegment.substring.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
                let segmentID = String(format: "%.1f|%@", lastSegment.timestamp, normalized)

                if !handledKeywordSegmentIDs.contains(segmentID),
                   isKeywordSegment(normalized, keyword: keyword) {
                    handledKeywordSegmentIDs.insert(segmentID)
                    print("[speech] detected stop keyword segment: \(normalized)")
                    handleKeywordToggle()
                }
            }

            if handledKeywordSegmentIDs.count > 2048 {
                handledKeywordSegmentIDs.removeAll(keepingCapacity: true)
            }
            return
        }

        let segments = result.bestTranscription.segments

        for segment in segments {
            let normalized = segment.substring.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            let segmentID = String(format: "%.1f|%@", segment.timestamp, normalized)

            guard !handledKeywordSegmentIDs.contains(segmentID) else { continue }
            guard isKeywordSegment(normalized, keyword: keyword) else { continue }

            handledKeywordSegmentIDs.insert(segmentID)
            handleKeywordToggle()
        }

        if handledKeywordSegmentIDs.count > 2048 {
            handledKeywordSegmentIDs.removeAll(keepingCapacity: true)
        }
    }

    private func isKeywordSegment(_ text: String, keyword: String) -> Bool {
        let pattern = "\\b\(NSRegularExpression.escapedPattern(for: keyword))\\b"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return false
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.firstMatch(in: text, options: [], range: range) != nil
    }

    private func containsCancelPhrase(in text: String) -> Bool {
        for phrase in cancelPhrases {
            let escapedPhrase = NSRegularExpression.escapedPattern(for: phrase)
            let flexibleWhitespacePattern = escapedPhrase.replacingOccurrences(of: "\\ ", with: "\\\\s+")
            let pattern = "\\b\(flexibleWhitespacePattern)\\b"

            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
                continue
            }

            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            if regex.firstMatch(in: text, options: [], range: range) != nil {
                return true
            }
        }

        return false
    }

    private func handleKeywordToggle() {
        let now = Date()
        guard now.timeIntervalSince(lastKeywordHandledAt) >= keywordDebounceSeconds else {
            return
        }

        let currentlyRecording = withAudioStateLock { isRecording }

        if currentlyRecording {
            if let recordingStartedAt,
               now.timeIntervalSince(recordingStartedAt) < minimumRecordingSeconds {
                print("[winston] ignoring stop keyword (too soon after start)")
                return
            }
            lastKeywordHandledAt = now
            stopRecording()
        } else {
            guard now >= ignoreStartKeywordsUntil else {
                print("[winston] ignoring start keyword (post-stop cooldown)")
                return
            }
            guard !waitingForTranscriptionClipboard else {
                print("[winston] waiting for prior transcription result; start ignored")
                return
            }
            lastKeywordHandledAt = now
            startRecording()
        }
    }

    private func startRecording() {
        guard !withAudioStateLock({ isRecording }) else { return }

        let inputFormat = audioEngine.inputNode.outputFormat(forBus: 0)
        let fileName = "capture-\(Int(Date().timeIntervalSince1970 * 1000)).wav"
        let fileURL = captureDirectory.appendingPathComponent(fileName)

        let recordingSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: inputFormat.sampleRate,
            AVNumberOfChannelsKey: inputFormat.channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]

        do {
            let recordingFile = try AVAudioFile(forWriting: fileURL, settings: recordingSettings)

            withAudioStateLock {
                currentRecordingFile = recordingFile
                isRecording = true
            }

            currentRecordingURL = fileURL
            recordingStartedAt = Date()
            interruptTtsPlayback()
            playCue(named: "Glass")
            duckOutputIfNeeded()
            print("[winston] start recording")
            scheduleRecognitionRestart(after: 0.05, reason: "recording started")
        } catch {
            print("[recording] failed to start: \(error.localizedDescription)")
        }
    }

    private func stopRecording() {
        guard withAudioStateLock({ isRecording }) else { return }

        withAudioStateLock {
            isRecording = false
            currentRecordingFile = nil
        }
        recordingStartedAt = nil
        ignoreStartKeywordsUntil = Date().addingTimeInterval(postStopStartCooldownSeconds)

        pendingFocusRestoreBundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier

        restoreOutputIfNeeded()
        playCue(named: "Pop")

        guard let fileURL = currentRecordingURL else { return }
        currentRecordingURL = nil

        print("[winston] stop recording")
        print("[recording] saved: \(fileURL.path)")
        scheduleRecognitionRestart(after: 0.05, reason: "recording stopped")

        if handoffToSuperwhisper(fileURL) {
            beginClipboardCapture(for: fileURL)
        } else {
            restoreDeferredFocusIfNeeded()
        }
    }

    private func playCue(named name: String) {
        let soundPath = "/System/Library/Sounds/\(name).aiff"
        guard FileManager.default.fileExists(atPath: soundPath) else { return }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
        process.arguments = [soundPath]

        do {
            try process.run()
        } catch {
            // ignore cue errors
        }
    }

    private func duckOutputIfNeeded() {
        guard duckOutputWhileRecording, !outputWasDucked else { return }

        if let outputSettings = readCurrentOutputSettings() {
            previousOutputVolume = outputSettings.volume
            previousOutputMuted = outputSettings.muted
        }

        _ = runAppleScript([
            "set volume without output muted",
            "set volume output volume \(duckedOutputVolumePercent)"
        ])

        outputWasDucked = true
        print("[audio] ducked output volume to \(duckedOutputVolumePercent)%")
    }

    private func restoreOutputIfNeeded() {
        guard outputWasDucked else { return }

        if let previousOutputMuted, previousOutputMuted {
            if let previousOutputVolume {
                _ = runAppleScript([
                    "set volume output volume \(previousOutputVolume)",
                    "set volume with output muted"
                ])
            } else {
                _ = runAppleScript(["set volume with output muted"])
            }
        } else if let previousOutputVolume {
            _ = runAppleScript([
                "set volume without output muted",
                "set volume output volume \(previousOutputVolume)"
            ])
        }

        outputWasDucked = false
        print("[audio] restored output volume")
    }

    private func readCurrentOutputSettings() -> (volume: Int, muted: Bool)? {
        guard let result = runAppleScript([
            "set v to output volume of (get volume settings)",
            "set m to output muted of (get volume settings)",
            "return (v as string) & \",\" & (m as string)"
        ]) else {
            return nil
        }

        let parts = result.split(separator: ",", omittingEmptySubsequences: false)
        guard parts.count == 2, let volume = Int(parts[0].trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }

        let mutedString = parts[1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let muted = mutedString == "true"
        return (volume, muted)
    }

    private func runAppleScript(_ lines: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = lines.flatMap { ["-e", $0] }

        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }

        guard process.terminationStatus == 0 else {
            return nil
        }

        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: outputData, encoding: .utf8) else {
            return nil
        }

        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func handoffToSuperwhisper(_ fileURL: URL) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", superwhisperAppName, fileURL.path]

        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = outputPipe

        do {
            try process.run()
            process.waitUntilExit()

            if process.terminationStatus == 0 {
                print("[superwhisper] handed off with focus: \(fileURL.path)")
                return true
            }

            let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: outputData, encoding: .utf8) ?? ""
            print("[superwhisper] handoff failed (exit \(process.terminationStatus)): \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
            return false
        } catch {
            print("[superwhisper] failed to run open command: \(error.localizedDescription)")
            return false
        }
    }

    private func restoreDeferredFocusIfNeeded() {
        let bundleID = pendingFocusRestoreBundleID
        pendingFocusRestoreBundleID = nil
        restoreFocusIfNeeded(toBundleID: bundleID)
    }

    private func restoreFocusIfNeeded(toBundleID bundleID: String?) {
        guard let bundleID, !bundleID.isEmpty else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            guard let frontmostBundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else {
                return
            }

            guard frontmostBundleID != bundleID else {
                return
            }

            let matchingApps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            guard let app = matchingApps.first else {
                return
            }

            app.activate(options: [.activateIgnoringOtherApps])
            print("[focus] restored to \(bundleID)")
        }
    }

    private func beginClipboardCapture(for wavURL: URL) {
        waitingForTranscriptionClipboard = true
        pendingTranscriptionWavURL = wavURL
        clipboardMonitorDeadline = Date().addingTimeInterval(clipboardTimeoutSeconds)

        let pasteboard = NSPasteboard.general
        clipboardBaselineChangeCount = pasteboard.changeCount
        clipboardSnapshotText = pasteboard.string(forType: .string)

        clipboardMonitorTimer?.cancel()

        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + clipboardPollIntervalSeconds, repeating: clipboardPollIntervalSeconds)
        timer.setEventHandler { [weak self] in
            self?.pollClipboardForTranscriptionResult()
        }
        timer.resume()
        clipboardMonitorTimer = timer

        print("[superwhisper] waiting for clipboard transcription...")
    }

    private func pollClipboardForTranscriptionResult() {
        guard waitingForTranscriptionClipboard,
              let wavURL = pendingTranscriptionWavURL,
              let deadline = clipboardMonitorDeadline else {
            stopClipboardMonitor(resetState: true)
            restoreDeferredFocusIfNeeded()
            return
        }

        if Date() >= deadline {
            print("[superwhisper] clipboard wait timed out; wav preserved: \(wavURL.path)")
            stopClipboardMonitor(resetState: true)
            restoreDeferredFocusIfNeeded()
            return
        }

        let pasteboard = NSPasteboard.general
        guard pasteboard.changeCount != clipboardBaselineChangeCount else {
            return
        }

        guard let text = pasteboard.string(forType: .string), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            clipboardBaselineChangeCount = pasteboard.changeCount
            return
        }

        if runPiInjectCommand(text) {
            restoreClipboardSnapshot()

            let txtURL = wavURL.deletingPathExtension().appendingPathExtension("txt")
            if FileManager.default.fileExists(atPath: txtURL.path) {
                do {
                    try FileManager.default.removeItem(at: txtURL)
                    print("[recording] removed txt artifact: \(txtURL.path)")
                } catch {
                    print("[recording] failed to remove txt artifact: \(error.localizedDescription)")
                }
            }

            do {
                try FileManager.default.removeItem(at: wavURL)
                print("[recording] removed wav: \(wavURL.path)")
            } catch {
                print("[recording] failed to remove wav after injection: \(error.localizedDescription)")
            }
            print("[pi] injected transcript into active session")
        } else {
            print("[pi] failed to inject transcript; wav preserved: \(wavURL.path)")
        }

        stopClipboardMonitor(resetState: true)
        restoreDeferredFocusIfNeeded()
    }

    private func interruptTtsPlayback() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/nc")
        process.arguments = ["-U", ttsControlSocketPath]

        let inputPipe = Pipe()
        process.standardInput = inputPipe
        process.standardOutput = Pipe()
        process.standardError = Pipe()

        do {
            try process.run()
            if let data = "interrupt\n".data(using: .utf8) {
                inputPipe.fileHandleForWriting.write(data)
            }
            inputPipe.fileHandleForWriting.closeFile()
            process.waitUntilExit()
        } catch {
            // Ignore TTS interrupt errors when control socket is unavailable.
        }
    }

    private func runPiInjectCommand(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            print("[pi] transcription empty after cleanup; skipping injection")
            return true
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: piInjectCommandPath)
        process.arguments = [trimmed]

        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = outputPipe

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            print("[pi] failed to run inject command: \(error.localizedDescription)")
            return false
        }

        guard process.terminationStatus == 0 else {
            let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: outputData, encoding: .utf8) ?? ""
            print("[pi] inject command failed (exit \(process.terminationStatus)): \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
            return false
        }

        return true
    }

    private func restoreClipboardSnapshot() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()

        guard let clipboardSnapshotText else {
            return
        }

        _ = pasteboard.setString(clipboardSnapshotText, forType: .string)
    }

    private func stopClipboardMonitor(resetState: Bool) {
        clipboardMonitorTimer?.cancel()
        clipboardMonitorTimer = nil

        guard resetState else { return }

        waitingForTranscriptionClipboard = false
        pendingTranscriptionWavURL = nil
        clipboardMonitorDeadline = nil
        clipboardSnapshotText = nil
    }

    private func setupSignalHandlers() {
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)

        let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        intSource.setEventHandler { [weak self] in
            self?.shutdown()
        }
        intSource.resume()
        sigintSource = intSource

        let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSource.setEventHandler { [weak self] in
            self?.shutdown()
        }
        termSource.resume()
        sigtermSource = termSource
    }

    private func cancelRecording() {
        guard withAudioStateLock({ isRecording }) else { return }

        withAudioStateLock {
            isRecording = false
            currentRecordingFile = nil
        }
        recordingStartedAt = nil
        ignoreStartKeywordsUntil = Date().addingTimeInterval(postStopStartCooldownSeconds)
        restoreOutputIfNeeded()
        playCue(named: "Funk")

        if let fileURL = currentRecordingURL {
            do {
                try FileManager.default.removeItem(at: fileURL)
                print("[winston] recording canceled")
                print("[recording] removed wav: \(fileURL.path)")
            } catch {
                print("[recording] failed to remove canceled wav: \(error.localizedDescription)")
            }
        }

        currentRecordingURL = nil
        scheduleRecognitionRestart(after: 0.05, reason: "recording canceled")
    }

    private func shutdown() {
        print("\nShutting down listener...")

        isShuttingDown = true

        pendingRecognitionRestartWorkItem?.cancel()
        pendingRecognitionRestartWorkItem = nil

        stopClipboardMonitor(resetState: true)
        pendingFocusRestoreBundleID = nil

        recognitionTask?.cancel()
        recognitionTask = nil

        let requestToEnd = withAudioStateLock {
            let request = recognitionRequest
            recognitionRequest = nil
            return request
        }
        requestToEnd?.endAudio()

        if withAudioStateLock({ isRecording }) {
            stopRecording()
        } else {
            restoreOutputIfNeeded()
        }

        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()

        exit(0)
    }
}

do {
    let app = WinstonListener()
    try app.run()
} catch {
    fputs("Error: \(error.localizedDescription)\n", stderr)
    exit(1)
}
