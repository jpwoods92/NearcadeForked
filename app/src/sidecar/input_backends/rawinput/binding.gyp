{
  "targets": [
    {
      "target_name": "rawinput_win",
      "sources": [ "rawinput-win.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "-lhid.lib",
            "-lsetupapi.lib"
          ]
        }]
      ],
      "cflags_cc": [ "-std=c++17", "-O3" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}
