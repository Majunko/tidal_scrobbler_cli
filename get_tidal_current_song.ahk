#Requires AutoHotkey v2.0+

; --- Configuration ---
targetExeName := "TIDAL.exe"
apiEndpoint := "YOUR_API_ENDPOINT_HERE"
logFile := "TidalInfo.log"
checkInterval := 5000

; --- State Variable ---
global scriptPaused := false ; Initially, the script is running

; --- Hotkey to Toggle Pause/Resume ---
^!t:: ; Ctrl + Alt + T
{
    global scriptPaused := !scriptPaused ; Toggle the paused state
    if (scriptPaused)
        ToolTip "Script Paused", , , 1 ; Show a tooltip indicating pause (ID 1)
    else
        ToolTip "Script Resumed", , , 1 ; Show a tooltip indicating resume (ID 1)
    SetTimer(() => ToolTip("", , , 1), -2000) ; Remove tooltip after 2 seconds
}

; --- Function to send data to the API ---
sendDataToAPI(artist, title) {
    global apiEndpoint, logFile
    static HTTP

    try {
        HTTP := ComObject("WinHttp.WinHttpRequest.5.1")
        if (!IsObject(HTTP)) {
            ; FileAppend("Error: Failed to create HTTP object.`n", logFile)
            return
        }
        HTTP.Open("POST", apiEndpoint, true)
        HTTP.SetRequestHeader("Content-Type", "application/json")
        jsonData := '{ "artist": "' . artist . '", "title": "' . title . '" }'
        HTTP.Send(jsonData)
        ; FileAppend("Sent to API - Artist: " . artist . ", Title: " . title . "`n", logFile)
        HTTP := "" ; release
    } catch as e {
        ; FileAppend("Error sending data to API: " . e.Message . "`n", logFile)
    }
}

; --- Function to get Tidal data ---
getTidalData() {
    global targetExeName, logFile
    windows := WinGetList()

    For hwnd in windows
    {
        exeName := WinGetProcessName(hwnd)
        if (exeName = targetExeName)
        {
            title := WinGetTitle(hwnd)
            winClass := WinGetClass(hwnd) ; Useful for debugging
            ; FileAppend("Found Tidal Window - Title: " . title . ", Class: " . winClass . ", Exe: " . exeName . "`n", logFile) ;log
            ; ToolTip "HWND: " hwnd "`nTitle: " title "`nClass: " winClass "`nExe: " exeName, A_ScreenWidth - 300, A_ScreenHeight - (A_Index * 80)

            If InStr(title, " - ")
            {
                parts := StrSplit(title, " - ")
                if (parts.Length = 2)
                {
                    artist := Trim(parts[2])
                    titleOnly := Trim(parts[1])
                    ; sendDataToAPI(artist, titleOnly)
                }
                /*
                else
                {
                    FileAppend("Title format not recognized: " . title . "`n", logFile)
                }
                */
            }
            /*
            else
            {
                FileAppend("Separator not found in title: " . title . "`n", logFile)
            }
            */
            return ; Exit after processing the first Tidal window
        }
    }
    FileAppend("Tidal window not found.`n", logFile)
}

; --- Main Execution Loop with Pause Check ---
Loop
{
    if (!scriptPaused) ; Only execute if the script is NOT paused
    {
        getTidalData()
    }
    Sleep checkInterval
    ; Tooltip ; Remove tooltip
}