{
  "targets": [
    {
      "target_name": "wasapi_capture",
      "sources": [
        "src/wasapi_capture.cpp",
        "src/audio_capture.cpp",
        "src/audio_engine.cpp",
        "src/wasapi_audio_engine.cpp",
        "src/av_packet.cpp",
        "src/audio_packet_manager.cpp",
        "src/audio_encoder.cpp",
        "src/audio_muxer.cpp",
        "src/audio_engine_encoder.cpp",
        "src/wasapi_audio_encoder_muxer.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "C:/vcpkg/installed/x64-windows/include"
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
          "library_dirs": [
            "C:/vcpkg/installed/x64-windows/lib"
          ],
          "libraries": [
            "-lole32",
            "-loleaut32",
            "-lwinmm",
            "-lksuser",
            "avcodec.lib",
            "avformat.lib",
            "avutil.lib",
            "swresample.lib"
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

