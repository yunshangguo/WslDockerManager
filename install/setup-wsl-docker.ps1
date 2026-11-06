#Requires -RunAsAdministrator
# WslDockerManager - 完整环境安装向导（手动运行入口，兼容旧文档）。
# 实际安装逻辑已统一到 setup-prereqs.ps1；此文件仅为薄封装，自动探测项目根目录。
$PSDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectDir = Split-Path -Parent $PSDir
& "$PSDir\setup-prereqs.ps1" -ProjectDir $ProjectDir -Distro 'Debian' -LogPath (Join-Path $PSDir 'prereqs-install.log')
