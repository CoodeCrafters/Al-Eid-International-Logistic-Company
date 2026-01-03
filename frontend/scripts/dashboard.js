const videos = [
    "videos/Logistics_Advertisement_Video_Generation.mp4",
    "videos/Logistics_Company_Promotional_Video_Creation.mp4",
    "videos/Logistics_GIF_Animation_Creation.mp4"
    
];

let currentVideoIndex = 0;
const videoElement = document.getElementById("bgVideo");

function playNextVideo() {
    videoElement.src = videos[currentVideoIndex];
    videoElement.load();
    videoElement.play();

    currentVideoIndex = (currentVideoIndex + 1) % videos.length;
}

videoElement.addEventListener("ended", playNextVideo);

// Start first video
playNextVideo();
