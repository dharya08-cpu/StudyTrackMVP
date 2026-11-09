// Node does password hashing, file work and DNS lookups on a small pool of worker threads (4 by default). A rush of
// sign-ins could keep all four busy and delay everything else, so give it more room. Override with UV_THREADPOOL_SIZE.
process.env.UV_THREADPOOL_SIZE ||= "6";
