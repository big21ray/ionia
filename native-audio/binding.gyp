{
  "targets": [
    {
      "target_name": "wasapi_capture",
      "sources": [
        "src/wasapi_capture.cpp",
        "src/audio_capture.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      },
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "-lole32",
            "-loleaut32",
            "-lwinmm",
            "-lksuser"
          ]
        }],
        ["target_arch=='ia32'", {
          "msvs_configuration_platform": "Win32"
        }],
        ["target_arch=='x64'", {
          "msvs_configuration_platform": "x64"
        }]
      ]
    }
  ]
}

