#!bin/bash
maxcounter=0x10001000
maxcounter=$(($maxcounter))
time=256
counter=0
addr1=1
result=0

#rpmbkey=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH
rpmbkey="rpmbkey.bin"
#rpmbpatch="/dev/block/mmcblk0rpmb"
rpmbpatch="/dev/mmcblk0rpmb"

#if [! -d "$rpmbpatch"]; then
#    rpmb_patch="/dev/mmcblk0rpmb"
#fi

#if [! -d "$rpmbkey"]; then
#    rpmbkey="AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
#fi

rm /data/block*
rm /data/test*
rm /data/source*

function error_type() {
	case $1 in
		"0x0000")
			;;
		"0x0001")
			echo "General failure"
			exit 0
			;;
		"0x0002")
			echo "Authentication failure"
			exit 0
			;;
		"0x0003")
			echo "Counter failure"
			exit 0
			;;
		"0x0004")
			echo "Address failure"
			exit 0
			;;
		"0x0005")
			echo "Write failure"
			exit 0
			;;
		"0x0006")
			echo "Read failure"
			exit 0
			;;
		"0x0007")
			echo "Authentication Key not yet programmed failure"
			;;
		"0x0080")
			echo "Max write count"
			;;
	esac
}

function random_file() {
	length=$1
	i=1
	seq=(0 1 2 3 4 5 6 7 8 9 a b c d e f g h i j k l m n o p q r s t u v w x y z A B C D E F G H I J K L M N O P Q R S T U V W X Y Z) 

	num_seq=${#seq[@]}
	while [ "$i" -le "$length" ]
	do
		seqrand[$i]=${seq[$((RANDOM%num_seq))]}
		let "i=i+1"
	done

	for j in ${seqrand[@]}
	do
		echo -n $j >> $2
	done
	echo
}

# 选择可用的 RPMB 节点
if [ ! -e "$rpmbpatch" ]; then
	if [ -e "/dev/block/mmcblk0rpmb" ]; then
		rpmbpatch="/dev/block/mmcblk0rpmb"
	elif [ -e "/dev/block/by-name/rpmb" ]; then
		rpmbpatch="/dev/block/by-name/rpmb"
	fi
fi
echo "rpmb device: $rpmbpatch"

eval $(./mmc_utils rpmb read-counter $rpmbpatch | grep "failed" | awk '{print "resualt="$5}')
error_type $resualt
resualt=${resualt:-0}
resualt=$(($resualt))
if [ "$resualt" == 7 ]; then
	echo "write rpmb key"
	write_out=$(cat $rpmbkey | ./mmc_utils rpmb write-key $rpmbpatch - 2>&1)
	echo "$write_out"
	eval $(echo "$write_out" | grep "failed" | awk '{print "resualt="$5}')
	resualt=${resualt:-0}
	resualt=$(($resualt))
	if [ "$resualt" != 0 ]; then
		error_type $resualt
		# 0x0001 常见于“密钥已烧写”；若之后能读 counter，则继续测试
		eval $(./mmc_utils rpmb read-counter $rpmbpatch | grep Counter | awk '{print "n_counter="$3}')
		if [ -n "$n_counter" ]; then
			echo "write-key returned $resualt but counter readable ($n_counter), continue"
		else
			echo "write failed"
			exit 0
		fi
	else
		echo "write rpmb key ok"
	fi
fi
eval $(./mmc_utils rpmb read-counter $rpmbpatch | grep Counter | awk '{print "n_counter="$3}')
if [ -z "$n_counter" ]; then
	echo "read-counter failed after key setup"
	./mmc_utils rpmb read-counter $rpmbpatch
	exit 0
fi
new_counter=$(($n_counter))
echo "write counter" $n_counter

while [ $new_counter -lt $maxcounter ]
do
	addr1=$((RANDOM%1023))
	addr2=$((RANDOM%1023+1023))
	num1=1
	num2=1

	#awk 'BEGIN {while (c++<64) printf "5555"}' > /data/source1.c
	#awk 'BEGIN {while (c++<64) printf "aaaa"}' > /data/source2.c
	#random_file /data
	random_file 256 /data/source1.c
	random_file 256 /data/source2.c

	l=0
	while [ $l -lt $num1 ]
	do
		cat /data/source1.c >> /data/block1.c
		l=$((${l}+1))
	done

	l=0
	while [ $l -lt $num2 ]
	do
		cat /data/source2.c >> /data/block2.c
		l=$((${l}+1))
	done

#first write & read
	eval $(./mmc_utils rpmb read-counter $rpmbpatch | grep Counter | awk '{print "counter="$3}')
	counter=$(($counter))
	write_result=$(cat $rpmbkey | ./mmc_utils rpmb write-block $rpmbpatch $addr1 /data/block1.c -)
	read_result=$(cat $rpmbkey | ./mmc_utils rpmb read-block $rpmbpatch $addr1 $num1 /data/test1.c -)

	eval $(./mmc_utils rpmb read-counter $rpmbpatch | grep Counter | awk '{print "n_counter="$3}')
	new_counter=$(($n_counter))
	if [ $new_counter != $(($counter + 1)) ]; then
		echo "write rpmb 1 block count mistake"
        	echo $read_result
        	echo $write_result
		echo $addr1
		echo $num1
		echo $new_counter
		exit 0
	fi
	
	diff /data/block1.c /data/test1.c > /data/diff1.c
	if [ $? != 0 ]; then
		echo "error: rpmb 1 read/write different!"
		cat /data/test1.c
		echo "\n"
        	echo $write_result
       	 	echo $read_result
		echo $addr1
        	echo $num1
		exit 0
	fi
	i=$(($new_counter%$time))
	if [ "$i" == 0 ]; then
		echo "write counter" $n_counter
	fi
	echo "write counter" $n_counter 
#second write & read
	eval $(./mmc_utils rpmb read-counter $rpmbpatch | grep Counter | awk '{print "counter="$3}')
	counter=$(($counter))
	write_result=$(cat $rpmbkey | ./mmc_utils rpmb write-block $rpmbpatch $addr2 /data/block2.c -)
	read_result=$(cat $rpmbkey | ./mmc_utils rpmb read-block $rpmbpatch $addr2 $num2 /data/test2.c -)

	eval $(./mmc_utils rpmb read-counter $rpmbpatch | grep Counter | awk '{print "n_counter="$3}')
	new_counter=$(($n_counter))
	if [ $new_counter != $(($counter + 1)) ]; then
		echo " write rpmb 2 block count mistake"
		echo $write_result
		echo $read_result
		echo $addr2
		echo $num2
		exit 0
	fi

	diff /data/block2.c /data/test2.c > /data/diff2.c
	if [ $? != 0 ]; then
		echo "error: rpmb 2 read/write different!"
		cat /data/diff2.c
		echo "\n"
        		echo $addr2
        		echo $num2
		echo $write_result
		echo $read_result
		exit 0
	fi

	i=$(($new_counter%$time))
	if [ "$i" == 0 ]; then
		echo "write counter" $n_counter
	fi

	rm /data/block1.c
	rm /data/block2.c
	rm /data/test1.c
	rm /data/test2.c
	rm /data/source*
done
exit 0
