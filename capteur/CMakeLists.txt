cmake_minimum_required(VERSION 3.24)
project(capteur CXX)

set(CMAKE_CXX_STANDARD 20)
# Runtime Visual C++ intégré : pas besoin d'installer le « Visual C++ Redistributable » chez l'hôte.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
set(FFMPEG_DIR "" CACHE PATH "Dossier d'une version « shared » de FFmpeg (include/, lib/, bin/)")
if(NOT FFMPEG_DIR)
  message(FATAL_ERROR "Indique -DFFMPEG_DIR=<dossier FFmpeg shared>")
endif()

add_executable(capteur capteur.cpp)
target_compile_definitions(capteur PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(capteur PRIVATE /utf-8 /W3)
target_include_directories(capteur PRIVATE "${FFMPEG_DIR}/include")
target_link_directories(capteur PRIVATE "${FFMPEG_DIR}/lib")
target_link_libraries(capteur PRIVATE avcodec avutil d3d11 dxgi winmm)

# Copie à côté de l'exécutable les seules DLL FFmpeg utilisées
set(FFMPEG_DLLS "${FFMPEG_DIR}/bin/avcodec-62.dll" "${FFMPEG_DIR}/bin/avutil-60.dll" "${FFMPEG_DIR}/bin/swresample-6.dll")
add_custom_command(TARGET capteur POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different ${FFMPEG_DLLS} $<TARGET_FILE_DIR:capteur>)
