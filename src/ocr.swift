// Tahoe Organize helper: reads the text in images with macOS Vision (the engine behind Live Text).
// One image path per line on stdin; one JSON object per line on stdout: {"path","text","error"}.
import Foundation
import Vision

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

while let path = readLine() {
    if path.isEmpty { continue }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
    do {
        try handler.perform([request])
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        emit(["path": path, "text": lines.joined(separator: "\n")])
    } catch {
        emit(["path": path, "text": "", "error": "\(error.localizedDescription)"])
    }
}
