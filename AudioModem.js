"use strict";

// generate a bit_freqs array as expected in the configuration
function generate_bit_freqs(count, freq_start, spacing) {
	let bit_freqs = []
	for (let i=0; i<count; i++) {
		bit_freqs.push({
			center: freq_start+i*spacing,
			gain: 0.1
		})
	}
	return bit_freqs
}

// Create an audio modem decoder
// fft_cb is called every time new FFT data is available
// symbol_cb is called every time a symbol has been decoded
function AudioModemDecoder(config, audio_ctx, fft_cb, symbol_cb) {
	// decoder state
	this.state = {
		clock_level: false, // current detected clock level
		averages: new Array(config.bit_freqs.length).fill(0), // current sum values of the FFT bins for bit data
		collected: 0, // current count of collected averages values
	}

	// get the FFT bin for the specified frequency
	this.get_bin_for_freq = (freq) => {
		let bin_size = audio_ctx.sampleRate / config.fft_size
		return Math.floor((freq+bin_size*0.5)/bin_size)
	}

	// process new FFT data
	this.process_fft = () => {
		this.analyser_node.getFloatFrequencyData(this.fft_bins)
		if (fft_cb) { fft_cb(this.fft_bins); }
		
		// the first frequency is used to clock the data on the other frequencies
		let clk_bin = this.fft_bins[this.get_bin_for_freq(config.bit_freqs[0].center)]
		// the second frequency is used to compare to as silence, since it's never active
		let low_bin = this.fft_bins[this.get_bin_for_freq(config.bit_freqs[1].center)]
		// calculate the deltas and compare to threshold
		let clock_level = (clk_bin - low_bin) > config.decode_threshold

		if (!this.state.clock_level && clock_level) {
			// rising clock edge, reset averages
			this.state.clock_level = true
			this.state.averages.fill(0)
			this.state.collected = 0
		} else if (this.state.clock_level && !clock_level) {
			// falling clock edge, get average from sums and decode symbol
			this.state.clock_level = false
			if (this.state.collected == 0) { return; }
			let bit_high = this.state.averages[0]/this.state.collected
			let bit_low = this.state.averages[1]/this.state.collected
			// get bits by thresholding each value
			let bits = this.state.averages.map((e) => {
				return (((e/this.state.collected)-bit_low)/(bit_high-bit_low)) > 0.5
			})
			console.log("sym", bits, this.state.collected, bit_high-bit_low)
			symbol_cb(bits.slice(2))
		} else if (this.state.clock_level) {
			// clock high, collect sums
			for (let i=0; i<config.bit_freqs.length; i++) {
				let bit_freq = config.bit_freqs[i]
				let bin_i = this.get_bin_for_freq(bit_freq.center)
				let bin = this.fft_bins[bin_i]
				this.state.averages[i] += bin
			}
			this.state.collected += 1
		}
	}

	// connect source to input of decoder graph(band-pass filter node)
	this.connect_source = (source_node) => {
		this.source_node = source_node
		this.source_node.connect(this.band_pass_node)
	}

	// create a band-pass filter, centered on the middle of the lowest and highest configured frequencies
	this.band_pass_node = audio_ctx.createBiquadFilter()
	this.band_pass_node.type = "bandpass"
	this.band_pass_node.frequency.value = (config.bit_freqs[0].center + config.bit_freqs[config.bit_freqs.length-1].center) / 2
	this.band_pass_node.Q.value = config.decode_bandpass_q

	// create an analyser node for getting FFT data from the source_node
	this.analyser_node = audio_ctx.createAnalyser()
	this.analyser_node.smoothingTimeConstant = config.fft_smoothing
	this.analyser_node.fftSize = config.fft_size
	this.fft_bins = new Float32Array(this.analyser_node.frequencyBinCount)

	// create a script node to get notified when the FFT has data available
	this.script_node = audio_ctx.createScriptProcessor(256)
	audio_ctx.createScriptProcessor()
	this.script_node.onaudioprocess = (e) => {
		this.process_fft()
	}

	// connect analyser to input node(band-pass filter)
	this.band_pass_node.connect(this.analyser_node)
	this.analyser_node.connect(this.script_node)
}


// Create an audio encoder
function AudioModemEncoder(config, audio_ctx) {
	// create a band-pass filter, centered on the middle of the lowest and highest configured frequencies
	// this node is also used to merge the signal channels
	this.band_pass_node = audio_ctx.createBiquadFilter()
	this.band_pass_node.type = "bandpass"
	this.band_pass_node.frequency.value = (config.bit_freqs[0].center + config.bit_freqs[config.bit_freqs.length-1].center) / 2
	this.band_pass_node.Q.value = config.encode_bandpass_q

	// create a gain node and connect it to the output
	this.gain_node = audio_ctx.createGain()
	this.band_pass_node.connect(this.gain_node)
	this.gain_node.connect(audio_ctx.destination)

	// create oscillator nodes and gain nodes for each configured frequency
	this.oscillators = config.bit_freqs.map((bit_freq) => {
		let osc_node = audio_ctx.createOscillator()
		osc_node.frequency.value = bit_freq.center
		let gain_node = audio_ctx.createGain()
		osc_node.connect(gain_node)
		osc_node.start()
		gain_node.connect(this.band_pass_node)
		gain_node.gain.value = 0
		return {
			osc_node: osc_node,
			gain_node: gain_node,
			freq: bit_freq,
		}
	})

	// encode symbols by modulating the gain over time
	this.encode = (symbols, start_t) => {
		let clock_osc = this.oscillators[0]
		let low_osc = this.oscillators[1]
		clock_osc.gain_node.gain.setValueAtTime(config.encode_gain_low, start_t)
		low_osc.gain_node.gain.setValueAtTime(config.encode_gain_low, start_t)
		
		// encode all symbols
		for (let i=0; i<symbols.length; i++) {
			let t = start_t + i * (config.symbol_duration + config.symbol_pause) * 0.001
			let bits = symbols[i]
			// encode each symbol by rising then holding then lowering the clock,
			// while encoding the data on data frequencies.
			clock_osc.gain_node.gain.setValueAtTime(config.encode_gain_high, t + (config.symbol_duration+config.symbol_pause) * 0.25 * 0.001)
			clock_osc.gain_node.gain.setValueAtTime(config.encode_gain_low, t + (config.symbol_duration+config.symbol_pause) * 0.75 * 0.001)
			for (let j=0; j<bits.length; j++) {
				let bit = bits[j]
				let bit_osc = this.oscillators[j+2]
				bit_osc.gain_node.gain.setValueAtTime(bit ? config.encode_gain_high : config.encode_gain_low, t)
			}
		}

		// stop all oscillators after every symbol has been encoded
		let stop_t = start_t + symbols.length * (config.symbol_duration + config.symbol_pause) * 0.001
		clock_osc.gain_node.gain.setValueAtTime(0, stop_t)
		low_osc.gain_node.gain.setValueAtTime(0, stop_t)
		this.oscillators.forEach(e => e.gain_node.gain.setValueAtTime(0, stop_t))
		console.log("started encoding", start_t, stop_t, stop_t-start_t)
	}
}
