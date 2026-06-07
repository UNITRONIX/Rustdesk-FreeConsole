//go:build windows && mesaembed

package main

import _ "embed"

//go:embed windows/opengl32.dll
var mesaDLLEmbed []byte

func mesaDLLBytes() []byte { return mesaDLLEmbed }
