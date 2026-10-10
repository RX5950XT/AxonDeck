/** 錄音與字幕共用音源，只合併音軌，不播放到喇叭。 */
export async function openRecordingAudio(source, micAudio = true) {
  if (!['mic', 'system', 'both'].includes(source)) throw new Error('無效的錄音音源')
  const inputs = []
  let context = null
  let output = null
  const close = async () => {
    output?.getTracks().forEach((track) => track.stop())
    inputs.forEach((input) => input.getTracks().forEach((track) => track.stop()))
    if (context && context.state !== 'closed') await context.close()
  }
  try {
    if (source !== 'mic') {
      const display = await navigator.mediaDevices.getDisplayMedia({
        audio: true, video: { width: 1, height: 1, frameRate: 1 }
      })
      inputs.push(display)
      display.getVideoTracks().forEach((track) => track.stop())
      if (!display.getAudioTracks().length) throw new Error('無法取得系統音訊')
    }
    if (source !== 'system') inputs.push(await navigator.mediaDevices.getUserMedia({ audio: micAudio }))
    if (source === 'both') {
      context = new AudioContext()
      const destination = context.createMediaStreamDestination()
      output = destination.stream
      for (const input of inputs) {
        const gain = context.createGain()
        // 兩路各半，避免相加後超過音量上限。
        gain.gain.value = 0.5
        context.createMediaStreamSource(input).connect(gain).connect(destination)
      }
      await context.resume()
    } else output = new MediaStream(inputs[0].getAudioTracks())
    return { stream: output, tracks: inputs.flatMap((input) => input.getAudioTracks()), close }
  } catch (error) {
    await close()
    throw error
  }
}
