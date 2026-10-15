-- Tahoe Organize: read the text in an image with macOS Vision (the engine behind Live Text).
use AppleScript version "2.7"
use framework "Foundation"
use framework "Vision"
use scripting additions

on run argv
	set imagePath to item 1 of argv
	set imageURL to current application's NSURL's fileURLWithPath:imagePath
	set requestHandler to current application's VNImageRequestHandler's alloc()'s initWithURL:imageURL options:(current application's NSDictionary's dictionary())
	set request to current application's VNRecognizeTextRequest's alloc()'s init()
	request's setRecognitionLevel:(current application's VNRequestTextRecognitionLevelAccurate)
	request's setUsesLanguageCorrection:true
	set {ok, theError} to requestHandler's performRequests:{request} |error|:(reference)
	if not ok then error (theError's localizedDescription() as text)
	set lines_ to {}
	repeat with observation in (request's results() as list)
		set candidate to (observation's topCandidates:1)'s firstObject()
		if candidate is not missing value then set end of lines_ to (candidate's |string|() as text)
	end repeat
	set AppleScript's text item delimiters to linefeed
	return lines_ as text
end run
